const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const { checkPerm, sendPushNotification } = require("../utils"); 
const Aggregators = require("../calculators");


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
// 15. GÉNÉRATION DES BULLETINS DE PAIE (PDF + PUSH NOTIFS) ✅
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

      const cnssPart = Math.round(record.salaire_base * (record.taux_cnss / 100));
      const irppPart = record.retenues - cnssPart;

      const htmlSlip = `
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <style>
        @page { size: A4; margin: 0; }
        body { font-family: 'Helvetica', 'Arial', sans-serif; color: #1e293b; margin: 0; padding: 0; background-color: #fff; }
        .page { width: 210mm; min-height: 297mm; padding: 20mm; margin: auto; box-sizing: border-box; position: relative; }
        
        .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #2563eb; padding-bottom: 20px; margin-bottom: 30px; }
        .company-info h1 { font-size: 24px; font-weight: 900; color: #1e293b; margin: 0; letter-spacing: -1px; }
        .company-info p { font-size: 10px; color: #64748b; margin: 2px 0; }
        .document-title { text-align: right; }
        .document-title h2 { font-size: 18px; font-weight: 800; color: #2563eb; margin: 0; text-transform: uppercase; }
        .document-title p { font-size: 12px; font-weight: bold; margin: 5px 0; color: #1e293b; }

        .info-grid { display: flex; gap: 20px; margin-bottom: 30px; }
        .info-card { flex: 1; border: 1px solid #e2e8f0; padding: 15px; border-radius: 12px; background-color: #f8fafc; }
        .info-card h3 { font-size: 9px; text-transform: uppercase; color: #64748b; margin: 0 0 10px 0; letter-spacing: 1px; border-bottom: 1px solid #e2e8f0; padding-bottom: 5px; }
        .info-card p { font-size: 11px; margin: 4px 0; line-height: 1.4; }
        .info-card strong { color: #0f172a; }

        table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
        th { font-size: 10px; text-transform: uppercase; background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0; padding: 12px 10px; text-align: left; }
        td { font-size: 11px; border: 1px solid #e2e8f0; padding: 10px; color: #334155; }
        
        .col-amount { text-align: right; font-weight: 600; width: 100px; }
        .col-base { text-align: center; width: 100px; color: #64748b; }

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
        }
        .net-label { font-size: 14px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; }
        .net-amount { font-size: 26px; font-weight: 900; color: #3b82f6; }

        .footer { position: absolute; bottom: 20mm; left: 20mm; right: 20mm; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 20px; }
        .footer p { font-size: 9px; color: #94a3b8; margin: 2px 0; line-height: 1.5; }
    </style>
</head>
<body>
    <div class="page">
    <div class="header">
        <div style="display: flex; align-items: center; gap: 15px;">
            <img src="https://cdn-icons-png.flaticon.com/512/9752/9752284.png" style="width: 50px; height: 50px;">
            <div class="company-info">
                <h1>SIRH SECURE</h1>
                <p>Solutions de Gestion RH & Opérationnelle</p>
                <p>Cotonou, Bénin</p>
            </div>
        </div>
        <div class="document-title">
            <h2>Bulletin de Paie</h2>
            <p>${record.mois.toUpperCase()} ${record.annee}</p>
        </div>
    </div>

        <div class="info-grid">
            <div class="info-card">
                <h3>Informations Salarié</h3>
                <p>Nom: <strong>${record.nom}</strong></p>
                <p>Matricule: <strong>${record.matricule}</strong></p>
                <p>Poste: <strong>${record.poste}</strong></p>
            </div>
            <div class="info-card">
                <h3>Détails Période</h3>
                <p>Mois: <strong>${record.mois} ${record.annee}</strong></p>
                <p>Mode: <strong>Virement / Mobile Money</strong></p>
            </div>
        </div>

        <table>
            <thead>
                <tr>
                    <th>Désignation</th>
                    <th class="col-base">Taux</th>
                    <th class="col-amount">Gains</th>
                    <th class="col-amount">Retenues</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>Salaire de base</td>
                    <td class="col-base">100%</td>
                    <td class="col-amount">${fmt(record.salaire_base)}</td>
                    <td class="col-amount"></td>
                </tr>
                <tr>
                    <td>Indemnités forfaitaires</td>
                    <td class="col-base">Fixe</td>
                    <td class="col-amount">${fmt(record.indemnites_fixes)}</td>
                    <td class="col-amount"></td>
                </tr>
                <tr>
                    <td>Primes variables</td>
                    <td class="col-base">Variable</td>
                    <td class="col-amount">${fmt(record.primes)}</td>
                    <td class="col-amount"></td>
                </tr>
                <tr>
                    <td style="color: #64748b;">Cotisation CNSS</td>
                    <td class="col-base">${record.taux_cnss}%</td>
                    <td class="col-amount"></td>
                    <td class="col-amount">${fmt(cnssPart)}</td>
                </tr>
                <tr>
                    <td style="color: #64748b;">Impôt IRPP</td>
                    <td class="col-base">${record.taux_irpp}%</td>
                    <td class="col-amount"></td>
                    <td class="col-amount">${fmt(irppPart)}</td>
                </tr>
                ${record.acomptes > 0 ? `
                <tr>
                    <td style="font-weight: bold; color: #d97706;">Acomptes / Avances perçues</td>
                    <td class="col-base">Déduction</td>
                    <td class="col-amount"></td>
                    <td class="col-amount" style="color: #d97706;">${fmt(record.acomptes)}</td>
                </tr>
                ` : ''}
            </tbody>
        </table>

        <div class="net-box">
            <div class="net-label">Net à Payer (CFA)</div>
            <div class="net-amount">${fmt(record.salaire_net)}</div>
        </div>

        <div class="footer">
            <p>Document numérique certifié par SIRH SECURE</p>
            <p>Généré le ${new Date().toLocaleDateString("fr-FR")} à ${new Date().toLocaleTimeString("fr-FR")}</p>
        </div>
    </div>
</body>
</html>`;

      // 2. CONVERSION VECTORIELLE
      const htmlBuffer = Buffer.from(htmlSlip, "utf-8");
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
      const { error: insertErr } = await supabase.from("paie").insert([
        {
          employee_id: record.id,
          mois: record.mois,
          annee: parseInt(record.annee),
          salaire_base: parseInt(record.salaire_base),
          primes: parseInt(record.primes),
          acomptes: parseInt(record.acomptes || 0), // Sauvegarde de l'acompte
          retenues: parseInt(record.retenues),
          salaire_net: parseInt(record.salaire_net),
          fiche_pdf_url: publicData.publicUrl,
        },
      ]);

      if (insertErr) throw insertErr;

      // ============================================================
      // 🔥 NOUVEAU : DÉCLENCHEMENT DE LA NOTIFICATION PUSH
      // ============================================================
      try {
        // A. On récupère l'ID utilisateur lié à cet employé
        const { data: emp } = await supabase
          .from("employees")
          .select("user_associated_id, nom")
          .eq("id", record.id)
          .single();

        if (emp && emp.user_associated_id) {
          // B. On envoie la notification
          sendPushNotification(
            emp.user_associated_id,
            "💸 Bulletin de Paie disponible !",
            `Bonjour ${emp.nom}, votre fiche de paie de ${record.mois} ${record.annee} est prête.`,
            "/#my-profile"
          );
        }
      } catch (pushErr) {
        console.error("Erreur lors de l'envoi du Push Paie:", pushErr.message);
      }
    }
    return res.json({ status: "success" });
  } catch (err) {
    console.error("❌ Erreur Paie:", err.message);
    return res.status(500).json({ error: "Erreur lors de la génération des bulletins." });
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


router.all("/read-config-salaries", async (req, res) => {
  const { data, error } = await supabase
    .from("salaries_config")
    .select("*")
    .eq("is_active", true);

  if (error) throw error;
  return res.json(data);
});




// --- SAUVEGARDER UNE RÈGLE DE PAIE DYNAMIQUE ---
router.post("/save-payroll-rule", async (req, res) => {
    if (!checkPerm(req, "can_manage_config")) return res.status(403).json({ error: "Accès refusé" });

    const { rule_name, condition_field, condition_operator, condition_value, action_type, action_value } = req.body;

    const { error } = await supabase.from('payroll_rules').insert([{
        rule_name,
        condition_field,
        condition_operator,
        condition_value,
        action_type,
        action_value: parseFloat(action_value)
    }]);

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ status: "success" });
});

// --- LISTER LES RÈGLES EXISTANTES ---
router.get("/list-payroll-rules", async (req, res) => {
    const { data, error } = await supabase.from('payroll_rules').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
});


router.all("/calculate-payroll-dynamic", async (req, res) => {
    // 1. On récupère les règles définies en base
    const { data: rules } = await supabase.from('payroll_rules').select('*');
    
    // 2. On récupère les données de l'employé (Pointages + Statut)
    const { employee_id } = req.body;
    const { data: emp } = await supabase.from('employees').select('*').eq('id', employee_id).single();
    
    let totalPrime = 0;
    
    // 3. Moteur d'inférence simple
    rules.forEach(rule => {
        let isMatch = false;
        
        // Comparaison dynamique
        if (rule.condition_operator === '==' && emp[rule.condition_field] == rule.condition_value) isMatch = true;
        if (rule.condition_operator === '>' && emp[rule.condition_field] > parseFloat(rule.condition_value)) isMatch = true;
        
        if (isMatch) {
            if (rule.action_type === 'ADD_FIXED') totalPrime += parseFloat(rule.action_value);
        }
    });

    return res.json({ totalPrime: totalPrime });
});


router.all("/process-payroll-advanced", async (req, res) => {
    const { month, year } = req.query;

    // 1. Récupérer toutes les règles
    const { data: rules } = await supabase.from('payroll_rules').select('*');

    // 2. Récupérer les employés
    const { data: employees } = await supabase.from('employees').select('*');

    const results = [];

    for (let emp of employees) {
        let automaticBonus = 0;
        let automaticDeduction = 0;

        // --- PHASE D'AGRÉGATION DES DONNÉES ---
        // On calcule les compteurs de l'employé pour le mois en cours
        const stats = {
            VISITS_COUNT: await countVisits(emp.id, month, year),
            TOTAL_HOURS: await calculateMonthlyHours(emp.id, month, year),
            LATE_COUNT: await countLates(emp.id, month, year)
        };

        // --- PHASE D'APPLICATION DES RÈGLES ---
        rules.forEach(rule => {
            let employeeValue = 0;
            
            // On mappe la source de la règle à notre objet stats
            if (rule.data_source === 'VISITS') employeeValue = stats.VISITS_COUNT;
            if (rule.data_source === 'ATTENDANCE') employeeValue = stats.TOTAL_HOURS;
            if (rule.data_source === 'LATE_COUNT') employeeValue = stats.LATE_COUNT;

            // Vérification de la condition
            let isTriggered = false;
            if (rule.condition_operator === '>' && employeeValue > rule.threshold) isTriggered = true;
            if (rule.condition_operator === '==' && employeeValue == rule.threshold) isTriggered = true;

            if (isTriggered) {
                if (rule.action_type === 'ADD_FIXED') automaticBonus += rule.action_value;
                if (rule.action_type === 'MULTIPLY') automaticBonus += (employeeValue * rule.action_value);
                if (rule.action_type === 'DEDUCT') automaticDeduction += rule.action_value;
            }
        });

        results.push({
            employee_id: emp.id,
            nom: emp.nom,
            bonus: automaticBonus,
            deductions: automaticDeduction,
            net_to_add: automaticBonus - automaticDeduction
        });
    }

    return res.json(results);
});



router.all("/compute-automated-payroll", async (req, res) => {
    try {
        const { month, year } = req.query;
        if (!month || !year) return res.status(400).json({ error: "Mois et année requis" });

        // 1. CALCUL INTELLIGENT DES DATES (Gère 28, 30 et 31 jours)
        const formattedMonth = String(month).padStart(2, '0');
        const startDate = `${year}-${formattedMonth}-01T00:00:00`;
        
        // On prend le jour 0 du mois suivant pour avoir le dernier jour du mois actuel
        const lastDay = new Date(year, parseInt(month), 0).getDate();
        const endDate = `${year}-${formattedMonth}-${lastDay}T23:59:59`;

        // 2. RÉCUPÉRATION DES DONNÉES DE BASE
        const [rulesRes, empsRes] = await Promise.all([
            supabase.from('payroll_rules').select('*').eq('is_active', true),
            supabase.from('employees').select('id, nom, employee_type, departement').not('statut', 'ilike', '%Sortie%')
        ]);

        const rules = rulesRes.data || [];
        const employees = empsRes.data || [];
        const payrollDraft = [];

        // Fonction de comparaison sécurisée (Remplace eval)
        const checkCondition = (val1, operator, val2) => {
            const v1 = parseFloat(val1);
            const v2 = parseFloat(val2);
            if (operator === '>') return v1 > v2;
            if (operator === '<') return v1 < v2;
            if (operator === '>=') return v1 >= v2;
            if (operator === '<=') return v1 <= v2;
            if (operator === '==') return v1 === v2;
            return false;
        };

        // 3. BOUCLE DE CALCUL OPTIMISÉE
        for (const emp of employees) {
            // On lance les 3 compteurs en parallèle pour gagner en vitesse
            const [vCount, hCount, lCount] = await Promise.all([
                Aggregators.countVisits(emp.id, startDate, endDate),
                Aggregators.calculateHours(emp.id, startDate, endDate),
                Aggregators.countLates(emp.id, startDate, endDate)
            ]);

            let bonus = 0;
            let deductions = 0;
            let details = [];

            // 4. APPLICATION DU MOTEUR DE RÈGLES
            rules.forEach(rule => {
                let sourceValue = 0;
                if (rule.data_source === 'VISITS') sourceValue = vCount;
                if (rule.data_source === 'ATTENDANCE') sourceValue = hCount;
                if (rule.data_source === 'LATE') sourceValue = lCount;

                // Utilisation de notre fonction de comparaison sécurisée
                if (checkCondition(sourceValue, rule.condition_operator, rule.condition_value)) {
                    let amount = 0;
                    if (rule.action_type === 'ADD_FIXED') amount = parseFloat(rule.action_value);
                    if (rule.action_type === 'MULTIPLY') amount = sourceValue * parseFloat(rule.action_value);
                    
                    if (amount > 0) {
                        bonus += amount;
                        details.push(`${rule.rule_name}: +${Math.round(amount)} F`);
                    } else if (amount < 0) {
                        deductions += Math.abs(amount);
                        details.push(`${rule.rule_name}: -${Math.round(Math.abs(amount))} F`);
                    }
                }
            });

            payrollDraft.push({
                employee_id: emp.id,
                nom: emp.nom,
                stats: { visites: vCount, heures: hCount, retards: lCount },
                computed_bonus: Math.round(bonus),
                computed_deductions: Math.round(deductions),
                explanation: details.length > 0 ? details.join(' | ') : "Aucune règle appliquée"
            });
        }

        console.log(`📊 Calcul auto terminé pour ${employees.length} employés (${month}/${year})`);
        return res.json(payrollDraft);

    } catch (err) {
        console.error("❌ Erreur calcul auto:", err.message);
        return res.status(500).json({ error: "Erreur technique lors du calcul. Vérifiez les logs." });
    }
});

module.exports = router;
