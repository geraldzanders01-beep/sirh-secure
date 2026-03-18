const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const { checkPerm } = require("../utils");

// Outils pour la génération des PDF
const libre = require("libreoffice-convert");
const { promisify } = require("util");
const convertAsync = promisify(libre.convert);
const pLimit = require("p-limit");
const pdfLimiter = pLimit(1);

router.all("/read-payroll-full", async (req, res) => {
  if (!checkPerm(req, "can_see_payroll")) {
    return res.status(403).json({ error: "Accès refusé" });
  }

  try {
    const currentUserId = req.user.emp_id;
    const { data: requester } = await supabase
      .from("employees")
      .select("hierarchy_path, management_scope")
      .eq("id", currentUserId)
      .single();

    let columns =
      "id, nom, matricule, poste, departement, statut, salaire_brut_fixe, indemnite_transport, indemnite_logement, role, hierarchy_path, employee_type";
    let query = supabase.from("employees").select(columns);

    // 1. SÉCURITÉ : Même logique de périmètre que la route 'read'
    if (checkPerm(req, "can_see_employees")) {
      // Admin voit tout
    } else if (req.user.role === "MANAGER" && requester) {
      let conditions = [];
      conditions.push(`hierarchy_path.eq.${requester.hierarchy_path}`);
      conditions.push(`hierarchy_path.ilike.${requester.hierarchy_path}/%`);
      if (requester.management_scope?.length > 0) {
        const scopeList = `(${requester.management_scope.map((s) => `"${s}"`).join(",")})`;
        conditions.push(`departement.in.${scopeList}`);
      }
      query = query.or(conditions.join(","));
    } else {
      query = query.eq("id", currentUserId);
    }

    // 2. FILTRE DE STATUT INTELLIGENT (C'est ici que ça se règle)
    const { status, type, dept, role } = req.query;

    if (status && status !== "all") {
      // On utilise la même règle : "Actif" inclut aussi "En Poste"
      if (status === "Actif") {
        query = query.in("statut", ["Actif", "En Poste", "ACTIF", "En poste"]);
      } else {
        query = query.eq("statut", status);
      }
    }

    if (type && type !== "all") query = query.eq("employee_type", type);
    if (dept && dept !== "all") query = query.eq("departement", dept);
    if (role && role !== "all") query = query.eq("role", role);

    const { data, error } = await query.order("nom", { ascending: true });

    if (error) throw error;
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 15. GÉNÉRATION DES BULLETINS DE PAIE (DESIGN PREMIUM PDF) ✅
// ============================================================

router.all("/process-payroll", async (req, res) => {
  if (!checkPerm(req, "can_see_payroll"))
    return res.status(403).json({ error: "Accès refusé" });

  const { payrollRecords } = req.body;

  try {
    for (const record of payrollRecords) {
      // Formatage des montants pour le design (ex: 1 500 000 CFA)
      const fmt = (val) =>
        new Intl.NumberFormat("fr-FR").format(val || 0) + " CFA";

      // Dans server.js, boucle record of payrollRecords
      const cnssPart = Math.round(
        record.salaire_base * (record.taux_cnss / 100),
      );
      const irppPart = record.retenues - cnssPart; // On déduit l'IRPP du reste des retenues

const htmlSlip = `
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <style>
        @page { size: A4; margin: 0; }
        body { font-family: 'Helvetica', 'Arial', sans-serif; color: #1e293b; margin: 0; padding: 0; background-color: #fff; }
        .page { width: 210mm; min-height: 297mm; padding: 20mm; margin: auto; box-sizing: border-box; position: relative; }
        
        /* En-tête */
        .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #2563eb; padding-bottom: 20px; margin-bottom: 30px; }
        .company-info h1 { font-size: 24px; font-weight: 900; color: #1e293b; margin: 0; letter-spacing: -1px; }
        .company-info p { font-size: 10px; color: #64748b; margin: 2px 0; }
        .document-title { text-align: right; }
        .document-title h2 { font-size: 18px; font-weight: 800; color: #2563eb; margin: 0; text-transform: uppercase; }
        .document-title p { font-size: 12px; font-weight: bold; margin: 5px 0; color: #1e293b; }

        /* Grille Infos */
        .info-grid { display: flex; gap: 20px; margin-bottom: 30px; }
        .info-card { flex: 1; border: 1px solid #e2e8f0; padding: 15px; border-radius: 12px; background-color: #f8fafc; }
        .info-card h3 { font-size: 9px; text-transform: uppercase; color: #64748b; margin: 0 0 10px 0; letter-spacing: 1px; border-bottom: 1px solid #e2e8f0; padding-bottom: 5px; }
        .info-card p { font-size: 11px; margin: 4px 0; line-height: 1.4; }
        .info-card strong { color: #0f172a; }

        /* Tableau */
        table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
        th { font-size: 10px; text-transform: uppercase; background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0; padding: 12px 10px; text-align: left; }
        td { font-size: 11px; border: 1px solid #e2e8f0; padding: 10px; color: #334155; }
        
        .col-amount { text-align: right; font-weight: 600; width: 100px; }
        .col-base { text-align: center; width: 100px; color: #64748b; }

        /* Totaux et Net */
        .summary-box { display: flex; justify-content: flex-end; margin-top: 10px; }
        .summary-table { width: 250px; }
        .summary-table td { border: none; padding: 5px 10px; }
        .summary-table .label { text-align: right; color: #64748b; }
        .summary-table .value { text-align: right; font-weight: bold; font-size: 12px; }
        
        .net-box { 
            margin-top: 20px; 
            background: #0f172a; 
            color: white; 
            padding: 20px; 
            border-radius: 12px; 
            display: flex; 
            justify-content: space-between; 
            align-items: center;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
        }
        .net-label { font-size: 14px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; }
        .net-amount { font-size: 26px; font-weight: 900; color: #3b82f6; }

        /* Bas de page */
        .footer { position: absolute; bottom: 20mm; left: 20mm; right: 20mm; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 20px; }
        .footer p { font-size: 9px; color: #94a3b8; margin: 2px 0; line-height: 1.5; }
        .signature-space { margin-top: 40px; display: flex; justify-content: space-between; }
        .signature-box { width: 200px; border-top: 1px dashed #cbd5e1; padding-top: 10px; font-size: 10px; color: #64748b; font-weight: bold; }
    </style>
</head>
<body>
    <div class="page">
        <!-- EN-TETE -->
        <div class="header">
            <div class="company-info">
                <h1>SIRH SECURE</h1>
                <p>Solutions de Gestion RH & Opérationnelle</p>
                <p>Cotonou, Bénin | Tél: +229 00 00 00 00</p>
                <p>RCCM: RB/COT/24 B 0000 | IFU: 0000000000000</p>
            </div>
            <div class="document-title">
                <h2>Bulletin de Paie</h2>
                <p>${record.mois.toUpperCase()} ${record.annee}</p>
                <p style="font-size: 9px; color: #64748b; font-weight: normal;">Réf: BP-${record.annee}-${record.matricule}</p>
            </div>
        </div>

        <!-- INFOS EMPLOYE -->
        <div class="info-grid">
            <div class="info-card">
                <h3>Informations Salarié</h3>
                <p>Nom: <strong>${record.nom}</strong></p>
                <p>Matricule: <strong>${record.matricule}</strong></p>
                <p>Poste: <strong>${record.poste}</strong></p>
                <p>Département: <strong>${record.departement || 'Non défini'}</strong></p>
            </div>
            <div class="info-card">
                <h3>Détails Contrat</h3>
                <p>Période: <strong>01/${record.mois} au 30/${record.mois}</strong></p>
                <p>Date d'embauche: <strong>${record.date_embauche || '--/--/----'}</strong></p>
                <p>Mode de paiement: <strong>Virement Mobile / Espèces</strong></p>
                <p>Temps de travail: <strong>100% (Temps plein)</strong></p>
            </div>
        </div>

        <!-- TABLEAU DES ELEMENTS -->
        <table>
            <thead>
                <tr>
                    <th>Désignation des éléments de salaire</th>
                    <th class="col-base">Base / Taux</th>
                    <th class="col-amount">Gains</th>
                    <th class="col-amount">Retenues</th>
                </tr>
            </thead>
            <tbody>
                <!-- ELEMENTS DE REVENUS -->
                <tr>
                    <td>Salaire de Base Fixe</td>
                    <td class="col-base">100%</td>
                    <td class="col-amount">${fmt(record.salaire_base)}</td>
                    <td class="col-amount"></td>
                </tr>
                <tr>
                    <td>Indemnités forfaitaires (Transport & Logement)</td>
                    <td class="col-base">Forfait</td>
                    <td class="col-amount">${fmt(record.indemnites_fixes)}</td>
                    <td class="col-amount"></td>
                </tr>
                <tr>
                    <td>Primes exceptionnelles et Gratifications</td>
                    <td class="col-base">Variable</td>
                    <td class="col-amount">${fmt(record.primes)}</td>
                    <td class="col-amount"></td>
                </tr>

                <!-- COTISATIONS ET IMPOTS -->
                <tr>
                    <td style="padding-left: 20px; color: #64748b;">Cotisation Sociale (CNSS)</td>
                    <td class="col-base">${record.taux_cnss}%</td>
                    <td class="col-amount"></td>
                    <td class="col-amount">${fmt(cnssPart)}</td>
                </tr>
                <tr>
                    <td style="padding-left: 20px; color: #64748b;">Impôt sur le Revenu (IRPP)</td>
                    <td class="col-base">${record.taux_irpp}% (est.)</td>
                    <td class="col-amount"></td>
                    <td class="col-amount">${fmt(irppPart)}</td>
                </tr>

                <!-- ACOMPTES -->
                ${record.acomptes > 0 ? `
                <tr>
                    <td style="font-weight: bold; color: #d97706;">Acomptes sur salaire / Avances perçues</td>
                    <td class="col-base">Déduction</td>
                    <td class="col-amount"></td>
                    <td class="col-amount" style="color: #d97706;">${fmt(record.acomptes)}</td>
                </tr>
                ` : ''}
            </tbody>
        </table>

        <!-- RECAPITULATIF -->
        <div class="summary-box">
            <table class="summary-table">
                <tr>
                    <td class="label">Total Salaire Brut :</td>
                    <td class="value">${fmt(record.salaire_base + record.indemnites_fixes + record.primes)}</td>
                </tr>
                <tr>
                    <td class="label">Total Retenues & Taxes :</td>
                    <td class="value" style="color: #ef4444;">- ${fmt(record.retenues)}</td>
                </tr>
                ${record.acomptes > 0 ? `
                <tr>
                    <td class="label">Total Acomptes :</td>
                    <td class="value" style="color: #ef4444;">- ${fmt(record.acomptes)}</td>
                </tr>
                ` : ''}
            </table>
        </div>

        <!-- ZONE NET A PAYER -->
        <div class="net-box">
            <div class="net-label">Net à Payer (CFA)</div>
            <div class="net-amount">${fmt(record.salaire_net)}</div>
        </div>

        <!-- SIGNATURES -->
        <div class="signature-space">
            <div class="signature-box">Signature de l'employeur</div>
            <div class="signature-box">Signature du salarié</div>
        </div>

        <!-- PIED DE PAGE -->
        <div class="footer">
            <p>Ce bulletin de paie est un document numérique certifié par le système SIRH SECURE.</p>
            <p>Généré le ${new Date().toLocaleDateString("fr-FR")} à ${new Date().toLocaleTimeString("fr-FR")}</p>
            <p>Pour faire valoir ce que de droit. L'absence de signature ne remet pas en cause la validité de la remise numérique.</p>
        </div>
    </div>
</body>
</html>
`;

      // 2. CONVERSION VECTORIELLE (HTML -> PDF via LibreOffice)
      const htmlBuffer = Buffer.from(htmlSlip, "utf-8");

      console.log("🔄 Conversion PDF Vectoriel pour :", record.nom);
      const pdfBuffer = await pdfLimiter(() =>
        convertAsync(htmlBuffer, ".pdf", undefined),
      );

      const fileName = `bulletin_${record.id}_${Date.now()}.pdf`;

      // 3. UPLOAD SUR SUPABASE STORAGE
      await supabase.storage.from("documents").upload(fileName, pdfBuffer, {
        contentType: "application/pdf",
        upsert: true,
      });

      const { data: publicData } = supabase.storage
        .from("documents")
        .getPublicUrl(fileName);

      // 4. INSERTION DANS LA TABLE PAIE
      await supabase.from("paie").insert([
        {
          employee_id: record.id,
          mois: record.mois,
          annee: parseInt(record.annee),
          salaire_base: parseInt(record.salaire_base),
          primes: parseInt(record.primes),
          retenues: parseInt(record.retenues),
          salaire_net: parseInt(record.salaire_net),
          fiche_pdf_url: publicData.publicUrl,
        },
      ]);
    }
    return res.json({ status: "success" });
  } catch (err) {
    console.error("❌ Erreur Paie:", err.message);
    return res
      .status(500)
      .json({ error: "Erreur lors de la génération des bulletins PDF." });
  }
});

router.all("/read-payroll", async (req, res) => {
  const { employee_id } = req.query;

  if (!employee_id) {
    return res.status(400).json({ error: "ID employé manquant" });
  }

  // 1. IDENTIFICATION DU CONTEXTE
  // On compare l'ID demandé avec l'ID stocké dans le Token JWT
  const isMe = String(req.user.emp_id) === String(employee_id);

  // 2. VÉRIFICATION DES DROITS (SÉCURITÉ SaaS)
  if (isMe) {
    // Cas : L'employé veut voir ses propres bulletins
    if (!checkPerm(req, "can_view_own_payroll")) {
      return res.status(403).json({
        error: "Accès à vos bulletins de paie désactivé par l'administration.",
      });
    }
  } else {
    // Cas : Un manager ou RH veut voir le bulletin d'un autre
    if (!checkPerm(req, "can_see_payroll")) {
      return res.status(403).json({
        error:
          "Accès refusé : Vous n'avez pas le droit de consulter la paie des collaborateurs.",
      });
    }
  }

  // 3. RÉCUPÉRATION DES DONNÉES
  try {
    const { data, error } = await supabase
      .from("paie")
      .select("*, employees(nom, poste)")
      .eq("employee_id", employee_id)
      // On trie par année puis par mois pour avoir les plus récents en haut
      .order("annee", { ascending: false });

    if (error) throw error;

    return res.json(data);
  } catch (err) {
    console.error("Erreur read-payroll:", err.message);
    return res
      .status(500)
      .json({ error: "Erreur lors de la récupération des bulletins." });
  }
});


// --- MISE À JOUR DES CONSTANTES DE PAIE ---
router.post("/update-config-salaries", async (req, res) => {
    if (!checkPerm(req, "can_see_payroll") && !checkPerm(req, "can_manage_config")) {
        return res.status(403).json({ error: "Accès refusé" });
    }

    const { cnss, irpp } = req.body;

    try {
        // Met à jour la CNSS
        await supabase.from("salaries_config").update({ value_number: parseFloat(cnss) }).eq("key_code", "CNSS_EMPLOYEE_RATE");
        // Met à jour l'IRPP
        await supabase.from("salaries_config").update({ value_number: parseFloat(irpp) }).eq("key_code", "IRPP_BASE_RATE");

        // Log d'audit
        await supabase.from("logs").insert([{
            agent: req.user.nom || "RH",
            action: "PARAMÈTRES PAIE",
            details: `Mise à jour des taux : CNSS (${cnss}%) | IRPP (${irpp}%)`
        }]);

        return res.json({ status: "success" });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// --- MARQUER UN BULLETIN COMME LU (PREUVE JURIDIQUE) ---
router.all("/mark-payroll-read", async (req, res) => {
  const { id } = req.body;

  try {
    // On vérifie d'abord si le bulletin n'a pas DÉJÀ été lu
    const { data: existing } = await supabase
      .from("paie")
      .select("date_consultation")
      .eq("id", id)
      .single();

    // S'il n'a jamais été lu, on enregistre la date actuelle
    if (existing && !existing.date_consultation) {
      const { error } = await supabase
        .from("paie")
        .update({ date_consultation: new Date().toISOString() })
        .eq("id", id);
      
      if (error) throw error;
    }

    return res.json({ status: "success" });
  } catch (err) {
    console.error("Erreur mark-payroll-read:", err.message);
    return res.status(500).json({ error: "Impossible de marquer comme lu" });
  }
});

router.all("/read-config-salaries", async (req, res) => {
  const { data, error } = await supabase
    .from("salaries_config")
    .select("*")
    .eq("is_active", true);

  if (error) throw error;
  return res.json(data);
});

module.exports = router;
