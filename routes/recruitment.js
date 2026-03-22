const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const { checkPerm, sendEmailAPI, isModuleActive } = require("../utils");

router.all("/candidate-action", async (req, res) => {
  if (!checkPerm(req, "can_see_recruitment")) {
    return res.status(403).json({ error: "Accès refusé aux actions de recrutement" });
  }

  const id = req.body.id;
  const action_type = req.body.action || req.body.action_type;
  const agent = req.body.agent;

  const candidateId = parseInt(id);
  if (isNaN(candidateId)) throw new Error("ID candidat invalide");

  const { data: candidat, error: candErr } = await supabase
    .from("candidatures")
    .select("*")
    .eq("id", id)
    .single();

  if (candErr || !candidat) {
    throw new Error("Candidat introuvable dans la base de données");
  }

  let nouveauStatut = "";
  let emailSujet = "";
  let emailHtml = "";

  // =========================================================
  // 🎨 CONFIGURATION DU TEMPLATE PREMIUM (MASTER)
  // =========================================================
  const logoUrl = "https://cdn-icons-png.flaticon.com/512/9752/9752284.png";
  
  const emailHeader = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; background-color: #ffffff;">
        <div style="background-color: #0f172a; padding: 30px; text-align: center;">
            <img src="${logoUrl}" style="width: 60px; height: 60px; margin-bottom: 10px;">
            <h1 style="color: #ffffff; margin: 0; font-size: 18px; letter-spacing: 2px; text-transform: uppercase;">Recrutement SIRH</h1>
        </div>
        <div style="padding: 40px; line-height: 1.6;">`;

  const emailFooter = `
        <p style="margin-top: 30px; border-top: 1px solid #e2e8f0; padding-top: 20px; font-size: 14px; color: #64748b;">
            Cordialement,<br>
            <strong>L'équipe Recrutement</strong><br>
            SIRH SECURE
        </p>
    </div>
    <div style="background-color: #f8fafc; padding: 20px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0;">
        Ceci est un message automatique de notre portail carrière. Merci de ne pas y répondre directement.
    </div>
  </div>`;

  // =========================================================
  // CAS 1 : INVITATION À UN ENTRETIEN
  // =========================================================
  if (action_type === "VALIDER_POUR_ENTRETIEN") {
    nouveauStatut = "ENTRETIEN";
    emailSujet = `Invitation à un entretien : ${candidat.poste_vise}`;
    emailHtml = emailHeader + `
        <h2 style="color: #2563eb; margin-top: 0;">Bonne nouvelle !</h2>
        <p>Bonjour <strong>${candidat.nom_complet}</strong>,</p>
        <p>Nous avons bien reçu votre candidature pour le poste de <strong>${candidat.poste_vise}</strong> et nous vous en remercions.</p>
        <p>Votre profil a retenu toute notre attention. Nous serions ravis d'échanger avec vous pour discuter de votre parcours et de vos motivations.</p>
        
        <div style="background-color: #eff6ff; border-left: 4px solid #2563eb; padding: 15px; margin: 20px 0;">
            <p style="margin: 0; font-size: 14px; color: #1e40af;">
                <strong>Prochaine étape :</strong> Nous vous proposons un entretien (en visioconférence ou dans nos locaux) dans les prochains jours.
            </p>
        </div>
        
        <p>Merci de nous indiquer vos disponibilités pour la semaine à venir en répondant à cet email.</p>
    ` + emailFooter;
  }

  // =========================================================
  // CAS 2 : REFUS IMMÉDIAT
  // =========================================================
  else if (action_type === "REFUS_IMMEDIAT") {
    nouveauStatut = "Refusé";
    emailSujet = `Mise à jour concernant votre candidature : ${candidat.poste_vise}`;
    emailHtml = emailHeader + `
        <h2 style="color: #1e293b; margin-top: 0;">Mise à jour de votre dossier</h2>
        <p>Bonjour <strong>${candidat.nom_complet}</strong>,</p>
        <p>Nous vous remercions de l'intérêt que vous portez à notre entreprise et pour votre candidature au poste de <strong>${candidat.poste_vise}</strong>.</p>
        <p>Cependant, après une lecture attentive de votre dossier, nous sommes au regret de vous informer que nous ne pouvons pas donner une suite favorable à votre demande pour le moment.</p>
        <p>Nous conservons toutefois vos coordonnées dans notre base de talents afin de vous recontacter si une opportunité correspondant davantage à votre profil se présentait.</p>
        <p>Nous vous souhaitons une excellente continuation dans vos recherches.</p>
    ` + emailFooter;
  }

  // =========================================================
  // CAS 3 : REFUS APRÈS ENTRETIEN
  // =========================================================
  else if (action_type === "REFUS_APRES_ENTRETIEN") {
    nouveauStatut = "Refusé après entretien";
    emailSujet = `Suite à notre entretien pour le poste de ${candidat.poste_vise}`;
    emailHtml = emailHeader + `
        <h2 style="color: #1e293b; margin-top: 0;">Mise à jour de votre candidature</h2>
        <p>Bonjour <strong>${candidat.nom_complet}</strong>,</p>
        <p>Nous tenons à vous remercier pour le temps que vous nous avez accordé lors de notre récent entretien.</p>
        <p>Nous avons apprécié nos échanges, toutefois, nous avons décidé de poursuivre le processus avec un autre candidat dont l'expérience est plus en adéquation avec nos besoins immédiats.</p>
        <p>Ce choix ne remet nullement en cause la qualité de votre parcours ni vos compétences techniques.</p>
        <p>Nous vous souhaitons beaucoup de succès dans vos futurs projets professionnels.</p>
    ` + emailFooter;
  }

  // =========================================================
  // CAS 4 : EMBAUCHE (AVEC CRÉATION DE COMPTE)
  // =========================================================
  else if (action_type === "ACCEPTER_EMBAUCHE") {
    nouveauStatut = "Embauché";
    const generatedPassword = Math.random().toString(36).slice(-8) + "!23";
    const username = candidat.email;
    const siteLink = "https://sirh.cataria-systems.com"; // Ton lien propre
    const empType = req.body.employee_type || "OFFICE";
    const empDept = req.body.departement || "À définir";
    const managerId = req.body.manager_id || null;

    // --- LOGIQUE BASE DE DONNÉES (Identique à la tienne, simplifiée) ---
    const { data: existing } = await supabase.from("app_users").select("id").eq("email", username).single();

    if (!existing) {
      const { data: newUser } = await supabase.from("app_users").insert([{ email: username, password: generatedPassword, nom_complet: candidat.nom_complet }]).select().single();

      if (newUser) {
        const { data: nextMatricule } = await supabase.rpc("get_next_formatted_matricule");
        
        const { data: newEmp } = await supabase.from("employees").insert([{
              user_associated_id: newUser.id,
              matricule: nextMatricule,
              nom: candidat.nom_complet,
              employee_type: empType,
              email: username,
              telephone: candidat.telephone,
              poste: candidat.poste_vise,
              departement: empDept,
              role: "EMPLOYEE",
              statut: "Actif",
              date_embauche: new Date().toISOString().split("T")[0],
              type_contrat: "Essai",
              solde_conges: 25,
              photo_url: candidat.photo_url || null,
              manager_id: managerId
        }]).select().single();

        if (newEmp) {
          let finalPath = String(newEmp.id);
          if (managerId) {
            const { data: manager } = await supabase.from("employees").select("hierarchy_path").eq("id", managerId).single();
            if (manager?.hierarchy_path) finalPath = `${manager.hierarchy_path}/${newEmp.id}`;
          }
          await supabase.from("employees").update({ hierarchy_path: finalPath }).eq("id", newEmp.id);
        }
      }
    }

    emailSujet = `Félicitations ! Bienvenue dans l'équipe - ${candidat.poste_vise}`;
    emailHtml = emailHeader + `
        <h2 style="color: #10b981; margin-top: 0;">Félicitations et Bienvenue !</h2>
        <p>Bonjour <strong>${candidat.nom_complet}</strong>,</p>
        <p>Nous avons le plaisir de vous confirmer votre embauche au poste de <strong>${candidat.poste_vise}</strong>.</p>
        <p>Votre profil utilisateur a été créé. Vous pouvez désormais accéder à votre espace SIRH pour gérer vos informations professionnelles.</p>
        
        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 25px; margin: 25px 0;">
            <p style="margin-top: 0; font-weight: bold; color: #64748b; font-size: 12px; text-transform: uppercase;">Vos accès sécurisés</p>
            <p style="margin: 10px 0;">🔗 <b>Portail :</b> <a href="${siteLink}" style="color: #2563eb;">Accéder à SIRH SECURE</a></p>
            <p style="margin: 10px 0;">👤 <b>Identifiant :</b> <span style="font-family: monospace;">${username}</span></p>
            <p style="margin: 10px 0;">🔑 <b>Mot de passe :</b> <span style="font-family: monospace; background: #e2e8f0; padding: 2px 6px; border-radius: 4px;">${generatedPassword}</span></p>
        </div>

        <p style="font-size: 13px; color: #64748b;"><i>Par mesure de sécurité, nous vous recommandons de modifier votre mot de passe lors de votre première connexion.</i></p>
        <p>Nous sommes ravis de vous compter parmi nous !</p>
    ` + emailFooter;
  }

  // =========================================================
  // 🚀 FINALISATION (MAJ BDD, EMAIL, LOG)
  // =========================================================
  await supabase.from("candidatures").update({ statut: nouveauStatut }).eq("id", candidateId);

  if (emailHtml !== "" && candidat.email) {
    try {
      await sendEmailAPI(candidat.email, emailSujet, emailHtml);
      console.log(`✅ Email de ${nouveauStatut} envoyé à ${candidat.email}`);
    } catch (mErr) {
      console.error("❌ Erreur SMTP:", mErr.message);
    }
  }

  await supabase.from("logs").insert([{
      agent: agent || "RH",
      action: "RECRUTEMENT",
      details: `${candidat.nom_complet} -> ${nouveauStatut}`
  }]);

  return res.json({ status: "success", message: `Candidat passé en ${nouveauStatut}` });
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
