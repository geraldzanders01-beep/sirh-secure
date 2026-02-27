const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const { checkPerm, sendEmailAPI } = require("../utils");

// ============================================================
// 6. MODULE DES CONGÉS (NOUVEAU ✅)
// ============================================================

// A. Demande de congé par l'employé

router.all("/leave", async (req, res) => {
  const b = req.body;
  let justifUrl = null;

    const justifFile = (req.files ||  if (justifFile) {
    const fileName = `justif_${Date.now()}_${justifFile.originalname}`;
    await supabase.storage
      .from("documents")
      .upload(fileName, justifFile.buffer);
    justifUrl = supabase.storage.from("documents").getPublicUrl(fileName)
      .data.publicUrl;
  }

  const { error } = await supabase.from("conges").insert([
    {
      employee_id: b.employee_id,
      type: b.type,
      date_debut: b.date_debut,
      date_fin: b.date_fin,
      motif: b.motif,
      employees_nom: b.nom,
      justificatif_url: justifUrl,
      statut: "En attente",
    },
  ]);

  if (error) throw error;
  return res.json({ status: "success" });
});

// ============================================================
// 6-B. LECTURE DES CONGÉS (CORRIGÉ POUR TOUS) ✅
// ============================================================
router.all("/read-leaves", async (req, res) => {
  // MODIFICATION : On ajoute la jointure 'employees(solde_conges)' pour récupérer le compteur en temps réel
  let query = supabase
    .from("conges")
    .select("*, employees(solde_conges)")
    .order("created_at", { ascending: false });

  // CAS 1 : Permission RH -> Voit tout
  if (req.user.permissions && req.user.permissions.can_see_employees) {
    // Pas de filtre
  }
  // CAS 2 : Employé -> Voit seulement ses demandes (Socle de base)
  else {
    query = query.eq("employee_id", req.user.emp_id);
  }

  const { data, error } = await query;
  if (error) throw error;

  const mapped = data.map((l) => ({
    id: l.id,
    record_id: l.id,
    Employees_nom: l.employees_nom || "Inconnu",
    Statut: l.statut,
    Type: l.type || "Congé",
    "Date Début": l.date_debut,
    "Date Fin": l.date_fin,
    motif: l.motif,
    justificatif_link: l.justificatif_url,
    solde_actuel: l.employees
      ? Array.isArray(l.employees)
        ? l.employees[0].solde_conges
        : l.employees.solde_conges
      : 0,
  }));
  return res.json(mapped);
});

// ============================================================
// 6-C. ACTION SUR UN CONGÉ (VALIDATION AVEC CALCUL JOURS OUVRÉS) ✅
// ============================================================
router.all("/leave-action", async (req, res) => {
  if (!req.user.permissions || !req.user.permissions.can_see_employees) {
    // Pour valider les congés des autres
    return res
      .status(403)
      .json({ error: "Accès refusé à la gestion des congés" });
  }

  const { id, decision, agent } = req.body;
  console.log(`⚖️ Décision RH : ${decision} pour le congé ID ${id}`);

  // 1. Récupérer les détails du congé et de l'employé lié
  const { data: conge, error: congeErr } = await supabase
    .from("conges")
    .select("*, employees(*)")
    .eq("id", id)
    .single();

  if (congeErr || !conge) throw new Error("Congé introuvable");

  if (conge.statut === decision) {
    return res.json({ status: "success", message: "Déjà traité" });
  }

  const employe = Array.isArray(conge.employees)
    ? conge.employees[0]
    : conge.employees;
  if (!employe) throw new Error("Employé lié introuvable");

  const typeConge = conge.type;

  // --- 2. CALCUL INTELLIGENT DES JOURS OUVRÉS (Lundi-Vendredi) ---
  const debut = new Date(conge.date_debut);
  const fin = new Date(conge.date_fin);
  let nbJours = 0;
  let loopDate = new Date(debut);

  // On boucle jour par jour
  while (loopDate <= fin) {
    const dayOfWeek = loopDate.getDay();
    // Si ce n'est pas Dimanche (0) et pas Samedi (6), on compte
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      nbJours++;
    }
    // Jour suivant
    loopDate.setDate(loopDate.getDate() + 1);
  }
  // -------------------------------------------------------------

  // 3. Mise à jour du statut du congé dans Supabase
  const { error: updateErr } = await supabase
    .from("conges")
    .update({ statut: decision })
    .eq("id", id);

  if (updateErr) throw updateErr;

  // 4. LOGIQUE DE MISE À JOUR DE L'EMPLOYÉ (Solde + Statut Global)
  if (decision === "Validé") {
    let updates = { statut: "Congé" };

    // On déduit le solde uniquement pour Congé Payé et Maladie
    // (On utilise le nouveau nbJours calculé sans les weekends)
    if (typeConge === "Congé Payé" || typeConge === "Maladie") {
      const soldeActuel = parseFloat(employe.solde_conges) || 0;
      updates.solde_conges = soldeActuel - nbJours;
    }

    await supabase.from("employees").update(updates).eq("id", employe.id);

    console.log(
      `📉 Employé ${employe.nom} mis à jour : Statut=Congé, Déduit=${nbJours}j`,
    );
  } else if (decision === "Refusé") {
    await supabase
      .from("employees")
      .update({ statut: "Actif" })
      .eq("id", employe.id);
  }

  // Emails
  let emailSubject = "";
  let emailHtml = "";

  if (decision === "Validé") {
    emailSubject = `Approbation de votre demande de congé - ${employe.nom}`;
    emailHtml = `
                            <div style="font-family: Arial, sans-serif; line-height: 1.6;">
                                <p>Bonjour ${employe.nom},</p>
                                <p>Nous avons le plaisir de vous informer que votre demande de <strong>${typeConge}</strong> a été officiellement <strong>APPROUVÉE</strong>.</p>
                                <p><strong>Durée validée :</strong> ${nbJours} jours ouvrés (Week-ends exclus).</p>
                                <p>Votre statut a été mis à jour dans le système. Nous vous souhaitons une excellente période de repos.</p>
                                <br>
                                <p>Cordialement,<br>Le Service RH</p>
                            </div>`;
  } else {
    emailSubject = `Mise à jour concernant votre demande de congé`;
    emailHtml = `
                            <div style="font-family: Arial, sans-serif; line-height: 1.6;">
                                <p>Bonjour ${employe.nom},</p>
                                <p>Nous vous informons que votre demande de <strong>${typeConge}</strong> n'a pas pu être validée par ${agent || "le service RH"}.</p>
                                <p>Conformément à nos procédures internes, nous vous invitons à vous rapprocher de votre responsable pour obtenir plus de précisions.</p>
                                <br>
                                <p>Cordialement,<br>Le service des Ressources Humaines</p>
                            </div>`;
  }

  try {
    if (employe.email) {
      await sendEmailAPI(employe.email, emailSubject, emailHtml);
    }
  } catch (mErr) {
    console.error("❌ Erreur envoi mail décision:", mErr.message);
  }

  // 6. Log d'audit
  await supabase.from("logs").insert([
    {
      agent: agent || "Système",
      action: "DÉCISION_CONGÉ",
      details: `${decision} pour ${employe.nom} (${nbJours}j ouvrés)`,
    },
  ]);

  return res.json({
    status: "success",
    message: `Demande ${decision.toLowerCase()} (${nbJours}j déduits)`,
  });
});

router.all("/check-returns", async (req, res) => {
  if (!req.user.permissions || !req.user.permissions.can_send_announcements) {
    // Car le robot envoie des flash_messages
    return res
      .status(403)
      .json({ error: "Accès refusé au robot de surveillance" });
  }

  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];

  const { data: retoursAttendus } = await supabase
    .from("conges")
    .select("employee_id, employees_nom, date_fin")
    .eq("statut", "Validé")
    .eq("date_fin", yesterdayStr);

  if (retoursAttendus && retoursAttendus.length > 0) {
    const alertes = [];
    for (const retour of retoursAttendus) {
      const { data: pointageToday } = await supabase
        .from("pointages")
        .select("id")
        .eq("employee_id", retour.employee_id)
        .gte("heure", `${todayStr}T00:00:00`)
        .limit(1);

      if (!pointageToday || pointageToday.length === 0) {
        // --- VÉRIFICATION DOUBLON ---
        // On vérifie si un message d'alerte n'existe pas déjà pour aujourd'hui
        const { data: exist } = await supabase
          .from("flash_messages")
          .select("id")
          .ilike("message", `%${retour.employees_nom}%`)
          .gte("created_at", `${todayStr}T00:00:00`);

        if (!exist || exist.length === 0) {
          await supabase.from("flash_messages").insert([
            {
              message: `ALERTE RETOUR : ${retour.employees_nom} absent au poste après congés.`,
              type: "Urgent",
              sender: "Robot SIRH",
              date_expiration: new Date(now.getTime() + 7200000).toISOString(), // Expire dans 2h
            },
          ]);
        }
        alertes.push({
          message: `Alerte générée pour ${retour.employees_nom}`,
        });
      }
    }
    return res.json({ status: "checked", alerts: alertes });
  }
  return res.json({ status: "success", message: "Rien à signaler" });
});

module.exports = router;
