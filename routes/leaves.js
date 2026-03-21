const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const { checkPerm, sendEmailAPI, sendPushNotification } = require("../utils"); 

// ============================================================
// 6. MODULE DES CONGÉS (NOUVEAU ✅)
// ============================================================

// A. Demande de congé par l'employé
// A. Demande de congé par l'employé
router.all("/leave", async (req, res) => {
  // 1. HELPER DE NETTOYAGE (Pour éviter les [object Object] ou les tableaux)
  const getVal = (val) => Array.isArray(val) ? val[0] : val;

  const b = req.body;
  const empId = getVal(b.employee_id);
  const type = getVal(b.type);
  const dateDebut = getVal(b.date_debut);
  const dateFin = getVal(b.date_fin);
  const motif = getVal(b.motif);
  const nom = getVal(b.nom);

  // LOG DE DIAGNOSTIC : Pour voir en direct sur Render ce qui arrive
  console.log(`📥 RECU CONGÉ - ID: ${empId}, Nom: ${nom}, Type: ${type}`);

  // SÉCURITÉ : Si l'ID est manquant, on arrête tout de suite
  if (!empId || empId === "undefined") {
    console.error("❌ Erreur : employee_id est manquant dans le body", b);
    return res.status(400).json({ error: "Identifiant employé manquant." });
  }

  let justifUrl = null;

  // 2. GESTION DU FICHIER (S'il y en a un)
  try {
    const justifFile = (req.files && Array.isArray(req.files)) 
      ? req.files.find((f) => f.fieldname === "justificatif") 
      : null;

    if (justifFile) {
      // On nettoie le nom du fichier (pas d'espaces, pas d'accents)
      const safeName = `${Date.now()}_${justifFile.originalname.replace(/[^a-z0-9.]/gi, '_')}`;
      
      const { data: upData, error: upErr } = await supabase.storage
        .from("documents")
        .upload(safeName, justifFile.buffer, {
          contentType: justifFile.mimetype,
          upsert: true
        });
      
      if (upErr) throw upErr;

      const { data: publicUrlData } = supabase.storage
        .from("documents")
        .getPublicUrl(safeName);
      
      justifUrl = publicUrlData.publicUrl;
      console.log("📎 Fichier uploadé :", justifUrl);
    }

    // 3. INSERTION DANS LA BASE DE DONNÉES
    const { error: dbErr } = await supabase.from("conges").insert([
      {
        employee_id: empId,
        type: type,
        date_debut: dateDebut,
        date_fin: dateFin,
        motif: motif,
        employees_nom: nom,
        justificatif_url: justifUrl,
        statut: "En attente",
      },
    ]);

    if (dbErr) throw dbErr;

    console.log("✅ Congé enregistré avec succès en base.");
    return res.json({ status: "success" });

  } catch (err) {
    console.error("💥 Erreur lors de la demande de congé :", err.message);
    return res.status(500).json({ error: err.message });
  }
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
// 6-C. ACTION SUR UN CONGÉ (VALIDATION AVEC PUSH NOTIFICATIONS) ✅
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
  // Note : on récupère user_associated_id pour envoyer le Push au bon compte
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

  while (loopDate <= fin) {
    const dayOfWeek = loopDate.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      nbJours++;
    }
    loopDate.setDate(loopDate.getDate() + 1);
  }

  // 3. Mise à jour du statut du congé dans Supabase
  const { error: updateErr } = await supabase
    .from("conges")
    .update({ statut: decision })
    .eq("id", id);

  if (updateErr) throw updateErr;

  // 4. LOGIQUE DE MISE À JOUR DE L'EMPLOYÉ (Solde + Statut Global)
  if (decision === "Validé") {
    let updates = { statut: "Congé" };

    if (typeConge === "Congé Payé" || typeConge === "Maladie") {
      const soldeActuel = parseFloat(employe.solde_conges) || 0;
      updates.solde_conges = soldeActuel - nbJours;
    }

    await supabase.from("employees").update(updates).eq("id", employe.id);
    console.log(`📉 Employé ${employe.nom} mis à jour : Statut=Congé, Déduit=${nbJours}j`);
  } else if (decision === "Refusé") {
    await supabase
      .from("employees")
      .update({ statut: "Actif" })
      .eq("id", employe.id);
  }

  // ============================================================
  // 🔥 NOUVEAU : DÉCLENCHEMENT DE LA NOTIFICATION PUSH NATIVE
  // ============================================================
  if (employe.user_associated_id) {
    const pushTitle = decision === "Validé" ? "✅ Congé Approuvé !" : "❌ Mise à jour Congé";
    const pushBody = decision === "Validé" 
      ? `Bonne nouvelle ${employe.nom}, votre demande pour ${typeConge} (${nbJours}j) a été validée.`
      : `Désolé ${employe.nom}, votre demande pour ${typeConge} n'a pas été acceptée.`;
    
    // On envoie le signal au téléphone de l'employé
    sendPushNotification(
      employe.user_associated_id, 
      pushTitle, 
      pushBody, 
      "/#my-profile" // Redirection vers son profil au clic
    );
  }

  // 5. ENVOI DE L'EMAIL (Logique existante)
  let emailSubject = "";
  let emailHtml = "";

  if (decision === "Validé") {
    emailSubject = `Approbation de votre demande de congé - ${employe.nom}`;
    emailHtml = `<div style="font-family: Arial, sans-serif; line-height: 1.6;">
                    <p>Bonjour ${employe.nom},</p>
                    <p>Nous avons le plaisir de vous informer que votre demande de <strong>${typeConge}</strong> a été officiellement <strong>APPROUVÉE</strong>.</p>
                    <p><strong>Durée validée :</strong> ${nbJours} jours ouvrés.</p>
                    <br><p>Cordialement,<br>Le Service RH</p>
                </div>`;
  } else {
    emailSubject = `Mise à jour concernant votre demande de congé`;
    emailHtml = `<div style="font-family: Arial, sans-serif; line-height: 1.6;">
                    <p>Bonjour ${employe.nom},</p>
                    <p>Nous vous informons que votre demande de <strong>${typeConge}</strong> n'a pas pu être validée par ${agent || "le service RH"}.</p>
                    <br><p>Cordialement,<br>Le service des Ressources Humaines</p>
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
