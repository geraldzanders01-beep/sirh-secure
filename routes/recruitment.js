const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const { checkPerm, sendEmailAPI, isModuleActive } = require("../utils");

router.all("/candidate-action", async (req, res) => {
  if (!checkPerm(req, "can_see_recruitment")) {
    return res
      .status(403)
      .json({ error: "Accès refusé aux actions de recrutement" });
  }

  // CORRECTION ICI : On accepte "action" ou "action_type" pour être compatible avec le HTML
  const id = req.body.id;
  const action_type = req.body.action || req.body.action_type;
  const agent = req.body.agent;

  console.log(`⚡ Traitement : ${action_type} pour ID : ${id}`);

  // 1. S'assurer que l'ID est valide
  const candidateId = parseInt(id);
  if (isNaN(candidateId)) throw new Error("ID candidat invalide");

  // 2. Récupérer les infos du candidat
  const { data: candidat, error: candErr } = await supabase
    .from("candidatures")
    .select("*")
    .eq("id", id)
    .single();

  if (candErr || !candidat) {
    console.error("❌ Candidat introuvable:", candidateId);
    throw new Error("Candidat introuvable dans la base de données");
  }

  let nouveauStatut = "";
  let emailSujet = "";
  let emailHtml = "";

  // =========================================================
  // CAS 1 : INVITATION À UN ENTRETIEN
  // =========================================================
  if (action_type === "VALIDER_POUR_ENTRETIEN") {
    nouveauStatut = "ENTRETIEN";
    emailSujet = `Votre candidature pour le poste de ${candidat.poste_vise}`;
    emailHtml = `
                    <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
                        <p>Bonjour <strong>${candidat.nom_complet}</strong>,</p>
                        <p>Nous avons bien reçu votre candidature pour le poste de <strong>${candidat.poste_vise}</strong> et nous vous en remercions.</p>
                        <p>Votre profil a retenu toute notre attention. Nous serions ravis d'échanger avec vous de vive voix pour discuter de votre parcours et de vos motivations.</p>
                        <p>Nous vous proposons un entretien (en visio ou dans nos locaux) dans les prochains jours.</p>
                        <p>Merci de nous indiquer vos disponibilités pour la semaine à venir par retour de mail.</p>
                        <br>
                        <p>Cordialement,</p>
                        <p><strong>L'équipe Recrutement<br>CORP-HR</strong></p>
                    </div>`;
  }

  // =========================================================
  // CAS 2 : REFUS IMMÉDIAT
  // =========================================================
  else if (action_type === "REFUS_IMMEDIAT") {
    nouveauStatut = "Refusé";
    emailSujet = `Votre candidature au poste de ${candidat.poste_vise}`;
    emailHtml = `
                    <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
                        <p>Bonjour <strong>${candidat.nom_complet}</strong>,</p>
                        <p>Nous vous remercions de l'intérêt que vous portez à notre entreprise et pour votre candidature au poste de <strong>${candidat.poste_vise}</strong>.</p>
                        <p>Cependant, après une lecture attentive de votre dossier, nous sommes au regret de vous informer que nous ne pouvons pas donner une suite favorable à votre candidature.</p>
                        <p>Nous conservons toutefois vos coordonnées afin de vous recontacter si une opportunité se présentait.</p>
                        <p>Nous vous souhaitons une excellente continuation.</p>
                        <br>
                        <p>Bien cordialement,</p>
                        <p><strong>L'équipe Recrutement</strong></p>
                    </div>`;
  }

  // =========================================================
  // CAS 3 : REFUS APRÈS ENTRETIEN
  // =========================================================
  else if (action_type === "REFUS_APRES_ENTRETIEN") {
    nouveauStatut = "Refusé après entretien";
    emailSujet = `Suite à notre entretien - ${candidat.poste_vise}`;
    emailHtml = `
                    <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
                        <p>Bonjour <strong>${candidat.nom_complet}</strong>,</p>
                        <p>Nous tenons à vous remercier pour le temps accordé lors de notre entretien.</p>
                        <p>Nous avons apprécié nos échanges. Toutefois, nous avons choisi un profil dont l'expérience est plus en adéquation avec nos besoins immédiats.</p>
                        <p>Ce choix ne remet pas en cause vos compétences. Nous vous souhaitons beaucoup de succès.</p>
                        <br>
                        <p>Sincèrement,</p>
                        <p><strong>L'équipe Recrutement<br>CORP-HR</strong></p>
                    </div>`;
  }

  // =========================================================
  // CAS 4 : EMBAUCHE (AVEC CRÉATION DE COMPTE)
  // =========================================================
  else if (action_type === "ACCEPTER_EMBAUCHE") {
    nouveauStatut = "Embauché";
    const generatedPassword = Math.random().toString(36).slice(-8) + "!23";
    const username = candidat.email;
    const siteLink = "https://dom4002.github.io/sirh-supabase-v2-frontend/";
    const empType = req.body.employee_type || "OFFICE";
    const empDept = req.body.departement || "À définir";
    const managerId = req.body.manager_id || null; // Récupération du manager si envoyé par le front

    const { data: existing } = await supabase
      .from("app_users")
      .select("id")
      .eq("email", username)
      .single();

    if (!existing) {
      const { data: newUser } = await supabase
        .from("app_users")
        .insert([
          {
            email: username,
            password: generatedPassword,
            nom_complet: candidat.nom_complet,
          },
        ])
        .select()
        .single();

      if (newUser) {
        const { data: nextMatricule, error: seqErr } = await supabase.rpc(
          "get_next_formatted_matricule",
        );
        if (seqErr) throw new Error("Erreur de génération de matricule");
        // -----------------------------------------------------

        // --- INITIALISATION DU COMPTE EMPLOYÉ ---
        // On récupère l'objet inséré (.select().single()) pour avoir son ID et calculer le path
        const { data: newEmp, error: empErr } = await supabase
          .from("employees")
          .insert([
            {
              user_associated_id: newUser.id,
              matricule: nextMatricule,
              nom: candidat.nom_complet,
              employee_type: empType,
              email: username,
              telephone: candidat.telephone,
              poste: candidat.poste_vise,
              departement: empDept, // Utilise maintenant le code (ex: 'IT')
              role: "EMPLOYEE",
              statut: "Actif",
              date_embauche: new Date().toISOString().split("T")[0],
              type_contrat: "Essai",
              solde_conges: 25,
              photo_url: candidat.photo_url || null,
              manager_id: managerId,
            },
          ])
          .select()
          .single();

        if (!empErr && newEmp) {
          // --- NOUVEAU : CALCUL AUTOMATIQUE DU HIERARCHY_PATH ---
          let finalPath = String(newEmp.id);
          if (managerId) {
            const { data: manager } = await supabase
              .from("employees")
              .select("hierarchy_path")
              .eq("id", managerId)
              .single();

            if (manager && manager.hierarchy_path) {
              finalPath = `${manager.hierarchy_path}/${newEmp.id}`;
            }
          }
          // Mise à jour du chemin
          await supabase
            .from("employees")
            .update({ hierarchy_path: finalPath })
            .eq("id", newEmp.id);
        }
      }
    }

    emailSujet = `Félicitations ! Confirmation d'embauche - ${candidat.poste_vise}`;
    emailHtml = `
        <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
            <h2 style="color: #10b981;">Félicitations ${candidat.nom_complet} !</h2>
            <p>Nous confirmons votre embauche au poste de <strong>${candidat.poste_vise}</strong>.</p>
            <p>Voici vos identifiants pour accéder à votre espace SIRH :</p>
            <div style="background: #f3f4f6; padding: 15px; border-radius: 8px;">
                <p>🔗 <strong>Lien :</strong> <a href="${siteLink}">${siteLink}</a></p>
                <p>👤 <strong>Identifiant :</strong> ${username}</p>
                <p>🔑 <strong>Mot de passe :</strong> ${generatedPassword}</p>
            </div>
            <br>
            <p>Bienvenue dans l'équipe !</p>
        </div>`;
  }

  // 3. Mise à jour statut Supabase
  await supabase
    .from("candidatures")
    .update({ statut: nouveauStatut })
    .eq("id", candidateId);

  // 4. Envoi Email
  if (emailHtml !== "" && candidat.email) {
    try {
      await sendEmailAPI(candidat.email, emailSujet, emailHtml);

      console.log(`✅ Email envoyé à ${candidat.email}`);
    } catch (mErr) {
      console.error("❌ Erreur SMTP:", mErr.message);
    }
  }

  // 5. Log
  await supabase
    .from("logs")
    .insert([
      {
        agent: agent || "RH",
        action: "RECRUTEMENT",
        details: `${candidat.nom_complet} -> ${nouveauStatut}`,
      },
    ]);

  return res.json({
    status: "success",
    message: `Candidat passé en ${nouveauStatut}`,
  });
});

router.all("/read-candidates", async (req, res) => {
  if (!(await isModuleActive("MOD_RECRUITMENT"))) {
    return res.status(404).json({ error: "Module Recrutement désactivé." });
  }

  if (!checkPerm(req, "can_see_recruitment")) {
    return res.status(403).json({ error: "Accès refusé au Recrutement" });
  }
  console.log("📂 Lecture des candidatures Supabase...");
  const { data, error } = await supabase
    .from("candidatures")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw error;
  return res.json(data);
});

router.all("/ingest-candidate", async (req, res) => {
  const b = req.body;
  console.log(`📥 Candidature reçue. Nom : ${b.nom_complet}`);

  // A. GESTION DES FICHIERS (On les traite en premier)
  let uploadedDocs = {
    cv_url: null,
    lm_url: null,
    diploma_url: null,
    id_card_url: null,
  };

  if (req.files && req.files.length > 0) {
    for (const file of req.files) {
      const fileName = `${Date.now()}_${file.originalname.replace(/\s/g, "_")}`;
      await supabase.storage
        .from("documents")
        .upload(fileName, file.buffer, { contentType: file.mimetype });
      const { data } = supabase.storage
        .from("documents")
        .getPublicUrl(fileName);

      if (file.fieldname === "cv") uploadedDocs.cv_url = data.publicUrl;
      if (file.fieldname === "lm") uploadedDocs.lm_url = data.publicUrl;
      if (file.fieldname === "diploma")
        uploadedDocs.diploma_url = data.publicUrl;
      if (file.fieldname === "id_card")
        uploadedDocs.id_card_url = data.publicUrl;
    }
  }

  // B. INSERTION DANS SUPABASE (En s'assurant que les données existent)
  const { error } = await supabase.from("candidatures").insert([
    {
      nom_complet: b.nom_complet,
      email: b.email,
      telephone: b.telephone,
      poste_vise: b.poste_vise,
      date_naissance: b.date_naissance || null,
      cv_url: uploadedDocs.cv_url,
      lm_url: uploadedDocs.lm_url,
      diploma_url: uploadedDocs.diploma_url,
      id_card_url: uploadedDocs.id_card_url,
      statut: "Nouveau",
    },
  ]);

  if (error) {
    console.error("❌ Erreur Insertion Candidature:", error.message);
    return res.status(500).json({ error: error.message });
  }

  console.log("✅ Candidature de " + b.nom_complet + " enregistrée.");
  return res.json({ status: "success" });
});

module.exports = router;
