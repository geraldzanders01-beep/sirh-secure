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
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; margin: 0; padding: 0; }
        .page { width: 210mm; min-height: 297mm; padding: 15mm; margin: auto; box-sizing: border-box; }
        
        .header { display: flex; justify-content: space-between; border-bottom: 2px solid #334155; padding-bottom: 10px; margin-bottom: 20px; }
        .logo-box { font-size: 24px; font-weight: 800; color: #0f172a; }
        .title-box { text-align: right; }
        
        .info-grid { display: flex; gap: 10px; margin-bottom: 20px; }
        .info-card { flex: 1; border: 1px solid #e2e8f0; padding: 10px; border-radius: 8px; font-size: 11px; }
        .label { font-size: 8px; color: #64748b; text-transform: uppercase; font-weight: bold; }
        
        table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 11px; }
        th { background: #f8fafc; border: 1px solid #e2e8f0; padding: 8px; text-align: left; }
        td { border: 1px solid #e2e8f0; padding: 8px; }
        
        .row-total { background: #f1f5f9; font-weight: bold; }
        .net-box { margin-top: 20px; background: #2563eb; color: white; padding: 15px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; }
        .net-amount { font-size: 22px; font-weight: 900; }
        .footer { font-size: 9px; color: #94a3b8; text-align: center; margin-top: 30px; border-top: 1px solid #f1f5f9; padding-top: 10px; }
    </style>
</head>
<body>
    <div class="page">
        <div class="header">
            <div class="logo-box">SIRH SECURE</div>
            <div class="title-box">
                <h2 style="margin:0; font-size:16px;">BULLETIN DE PAIE</h2>
                <p style="margin:0; font-size:10px;">Période : ${record.mois} ${record.annee}</p>
            </div>
        </div>

        <div class="info-grid">
            <div class="info-card">
                <span class="label">Employeur</span><br>
                <strong>SIRH-SECURE SOLUTIONS</strong><br>Cotonou, Bénin
            </div>
            <div class="info-card">
                <span class="label">Salarié</span><br>
                <strong>${record.nom}</strong><br>
                Matricule: ${record.matricule}<br>
                Poste: ${record.poste}
            </div>
        </div>

        <table>
            <thead>
                <tr>
                    <th>Désignation</th>
                    <th>Base / Taux</th>
                    <th style="text-align:right">Gains</th>
                    <th style="text-align:right">Retenues</th>
                </tr>
            </thead>
            <tbody>
                <!-- GAINS -->
                <tr>
                    <td>Salaire de base</td>
                    <td>100%</td>
                    <td style="text-align:right">${fmt(record.salaire_base)}</td>
                    <td></td>
                </tr>
                <tr>
                    <td>Indemnités contractuelles (Logement/Transp.)</td>
                    <td>Fixe</td>
                    <td style="text-align:right">${fmt(record.indemnites_fixes)}</td>
                    <td></td>
                </tr>
                <tr>
                    <td>Primes et gratifications</td>
                    <td>Variable</td>
                    <td style="text-align:right">${fmt(record.primes)}</td>
                    <td></td>
                </tr>
                
                <!-- RETENUES EXPLICITES -->
                <tr>
                    <td>Cotisation Sociale (CNSS)</td>
                    <td>${record.taux_cnss}%</td>
                    <td></td>
                    <td style="text-align:right">${fmt(cnssPart)}</td>
                </tr>
                <tr>
                    <td>Impôt sur le Revenu (IRPP)</td>
                    <td>${record.taux_irpp}% (est.)</td>
                    <td></td>
                    <td style="text-align:right">${fmt(irppPart)}</td>
                </tr>

                <tr class="row-total">
                    <td>TOTAUX</td>
                    <td></td>
                    <td style="text-align:right">${fmt(record.salaire_base + record.indemnites_fixes + record.primes)}</td>
                    <td style="text-align:right">${fmt(record.retenues)}</td>
                </tr>
            </tbody>
        </table>

        <div class="net-box">
            <span style="font-weight:bold; text-transform:uppercase;">Net à percevoir</span>
            <span class="net-amount">${fmt(record.salaire_net)}</span>
        </div>

        <div class="footer">
            Bulletin de paie numérique généré le ${new Date().toLocaleDateString("fr-FR")}<br>
            Pour faire valoir ce que de droit.
        </div>
    </div>
</body>
</html>`;

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
