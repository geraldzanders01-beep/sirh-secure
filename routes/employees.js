const express = require("express");
const archiver = require('archiver');
const axios = require('axios');
const router = express.Router();
const supabase = require("../supabaseClient");
const { checkPerm, getEndDate, sendEmailAPI } = require("../utils");

// 5. CRÉATION PROFIL (WRITE)
router.all("/write", async (req, res) => {
  if (!checkPerm(req, "can_create_profiles")) {
    return res
      .status(403)
      .json({ error: "Accès refusé à la création de profils" });
  }

  // NETTOYAGE DES DOUBLONS (Sécurité)
  // Si contract_template_id arrive sous forme de tableau, on ne prend que le premier élément
  if (Array.isArray(req.body.contract_template_id)) {
    req.body.contract_template_id = req.body.contract_template_id[0];
  }

  const body = req.body;
  console.log("📥 Création profil pour :", body.nom);

  let uploadedDocs = {
    photo_url: null,
    id_card_url: null,
    cv_url: null,
    diploma_url: null,
    attestation_url: null,
  };

  // --- A. GESTION DES FICHIERS (Multer) --- (CE BLOC RESTE INCHANGÉ)
  if (req.files && req.files.length > 0) {
    for (const file of req.files) {
      const fileExt = file.originalname.split(".").pop();
      const fileName = `DOC_${file.fieldname.toUpperCase()}_${body.nom.replace(/\s/g, "_")}_${Date.now()}.${fileExt}`;
      const { error } = await supabase.storage
        .from("documents")
        .upload(fileName, file.buffer, { contentType: file.mimetype });
      if (!error) {
        const { data } = supabase.storage
          .from("documents")
          .getPublicUrl(fileName);
        if (file.fieldname === "photo") uploadedDocs.photo_url = data.publicUrl;
        if (file.fieldname === "id_card")
          uploadedDocs.id_card_url = data.publicUrl;
        if (file.fieldname === "cv") uploadedDocs.cv_url = data.publicUrl;
        if (file.fieldname === "diploma")
          uploadedDocs.diploma_url = data.publicUrl;
        if (file.fieldname === "attestation")
          uploadedDocs.attestation_url = data.publicUrl;
      }
    }
  }

  const generatedPassword = Math.random().toString(36).slice(-8) + "!23";

  // --- B. CRÉATION DANS APP_USERS --- (CE BLOC RESTE INCHANGÉ)
  const { data: newUser, error: uErr } = await supabase
    .from("app_users")
    .insert([
      {
        email: body.email,
        password: generatedPassword,
        nom_complet: body.nom,
      },
    ])
    .select()
    .single();

  if (uErr) {
    console.error("Erreur app_users:", uErr.message);
    return res.json({ error: "Email déjà utilisé ou erreur base de données" });
  }

  // --- C. GÉNÉRATION DU MATRICULE ROBUSTE (Anti-doublon) ---
  const { data: nextMatricule, error: seqErr } = await supabase.rpc(
    "get_next_formatted_matricule",
  );
  if (seqErr) throw new Error("Erreur de génération de matricule");
  // -----------------------------------------------------
  const daysLimit = body.limit || "365"; // Récupère la durée choisie (90, 180, 365)

  // --- D. INSERTION DANS EMPLOYEES (AVEC LES NOUVEAUX CHAMPS CONTRACTUELS) ---
  const { data: newEmp, error: empErr } = await supabase
    .from("employees")
    .insert([
      {
        user_associated_id: newUser.id,
        matricule: nextMatricule,
        nom: body.nom,
        email: body.email,
        telephone: body.telephone,
        adresse: body.adresse,
        poste: body.poste,
        departement: body.dept,
        role: body.role || "EMPLOYEE",
        employee_type: body.employee_type || "OFFICE",
        statut: "Actif",
        date_embauche: body.date,
        date_fin_contrat: getEndDate(body.date, daysLimit),
        type_contrat:
          body.limit === "365" ? "CDI" : body.limit === "180" ? "CDD" : "Essai",
        solde_conges: 25,
        photo_url: uploadedDocs.photo_url,
        id_card_url: uploadedDocs.id_card_url,
        cv_url: uploadedDocs.cv_url,
        diploma_url: uploadedDocs.diploma_url,
        attestation_url: uploadedDocs.attestation_url,
        manager_id: body.manager_id === "" ? null : body.manager_id,
        management_scope: body.scope ? JSON.parse(body.scope) : [],
        civilite: body.civilite,
        salaire_brut_fixe: parseFloat(body.salaire_fixe) || 0,
        indemnite_transport: parseFloat(body.indemnite_transport) || 0,
        indemnite_logement: parseFloat(body.indemnite_logement) || 0, // Ajouté si le front le fournit
        temps_travail: body.temps_travail,
        duree_essai: body.duree_essai,
        lieu_signature: body.lieu_signature,
        contract_template_id:
          body.contract_template_id && body.contract_template_id !== ""
            ? body.contract_template_id
            : null,
        lieu_naissance: body.lieu_naissance,
        nationalite: body.nationalite,
      },
    ])
    .select()
    .single();

  if (empErr) {
    console.error("Erreur employees:", empErr.message);
    throw empErr;
  }

  // --- E. CALCUL DU HIERARCHY_PATH --- (CE BLOC RESTE INCHANGÉ)
  let path = String(newEmp.id);
  if (body.manager_id && body.manager_id !== "") {
    const { data: manager } = await supabase
      .from("employees")
      .select("hierarchy_path")
      .eq("id", body.manager_id)
      .single();
    if (manager && manager.hierarchy_path) {
      path = `${manager.hierarchy_path}/${newEmp.id}`;
    }
  }
  await supabase
    .from("employees")
    .update({ hierarchy_path: path })
    .eq("id", newEmp.id);

  // --- F. ENVOI DE L'EMAIL DE BIENVENUE --- (CE BLOC RESTE INCHANGÉ)
  const emailSujet = `Bienvenue chez SIRH SECURE - Vos accès`;
// Remplace la variable emailHtml dans la route "/write"
const emailHtml = `
<div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #1e293b; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden;">
    <div style="background-color: #0f172a; padding: 30px; text-align: center;">
        <img src="https://cdn-icons-png.flaticon.com/512/9752/9752284.png" style="width: 70px; height: 70px;">
        <h1 style="color: #ffffff; margin: 10px 0 0 0; font-size: 20px; letter-spacing: 2px; text-transform: uppercase;">SIRH SECURE</h1>
    </div>
    <div style="padding: 40px; line-height: 1.6;">
        <h2 style="color: #0f172a; margin-top: 0;">Félicitations ${body.nom} !</h2>
        <p>Votre profil collaborateur a été créé avec succès dans notre système de gestion.</p>
        <p>Vous pouvez désormais accéder à votre portail sécurisé pour gérer vos pointages, vos congés et consulter vos documents RH.</p>
        
        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 25px; margin: 30px 0;">
            <p style="margin-top: 0; font-weight: bold; color: #64748b; font-size: 12px; text-transform: uppercase;">Vos identifiants d'accès</p>
            <p style="margin: 10px 0;">🔗 <b>Lien :</b> <a href="https://sirh.cataria-systems.com" style="color: #2563eb; text-decoration: none;">Accéder au Portail</a></p>
            <p style="margin: 10px 0;">👤 <b>Identifiant :</b> <span style="font-family: monospace;">${body.email}</span></p>
            <p style="margin: 10px 0;">🔑 <b>Mot de passe :</b> <span style="font-family: monospace; background: #e2e8f0; padding: 2px 6px; border-radius: 4px;">${generatedPassword}</span></p>
        </div>

        <p style="font-size: 14px; color: #64748b;"><i>Note : Par mesure de sécurité, nous vous conseillons de modifier votre mot de passe dès votre première connexion.</i></p>
    </div>
    <div style="background-color: #f1f5f9; padding: 20px; text-align: center; font-size: 11px; color: #94a3b8;">
        &copy; 2026 SIRH SECURE - Système de Gestion RH Intégré
    </div>
</div>`;

  await sendEmailAPI(body.email, emailSujet, emailHtml);

  return res.json({ status: "success" });
});

router.all("/read", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  const search = req.query.search || "";
  const status = req.query.status || "all";
  const type = req.query.type || "all";
  const dept = req.query.dept || "all";
  const targetId = req.query.target_id || "";
  const roleFilter = req.query.role || "all";

  try {
    const currentUserId = req.user.emp_id;

    const { data: requester } = await supabase
      .from("employees")
      .select("hierarchy_path, management_scope")
      .eq("id", currentUserId)
      .single();

    if (targetId) {
      if (!checkPerm(req, "can_see_employees")) {
        // CORRECTION MAJEURE : Si l'utilisateur demande à voir SON PROPRE profil, on le laisse passer immédiatement
        if (String(targetId) === String(currentUserId)) {
          // Accès autorisé à soi-même
        } else {
          let idorQuery = supabase
            .from("employees")
            .select("id")
            .eq("id", targetId);
          let idorConditions = [];

          // On vérifie que la hiérarchie existe avant de l'interroger
          if (requester && requester.hierarchy_path) {
            idorConditions.push(
              `hierarchy_path.ilike.${requester.hierarchy_path}/%`,
            );
          }

          if (requester && requester.management_scope?.length > 0) {
            const scopeList = `(${requester.management_scope.map((s) => `"${s}"`).join(",")})`;
            idorConditions.push(`departement.in.${scopeList}`);
          }

          if (idorConditions.length > 0) {
            const { data: checkAccess } = await idorQuery
              .or(idorConditions.join(","))
              .maybeSingle();
            if (!checkAccess) {
              return res
                .status(403)
                .json({ error: "Accès refusé : Profil hors périmètre." });
            }
          } else {
            return res
              .status(403)
              .json({ error: "Accès refusé : Aucun périmètre défini." });
          }
        }
      }
    }

    // ============================================================
    // 🛡️ PHASE 5 : SÉCURITÉ DES COLONNES SENSIBLES (SALAIRES)
    // ============================================================
    // Liste des colonnes autorisées pour tous
    let columns =
      "id, nom, matricule, poste, departement, statut, role, photo_url, employee_type, date_embauche, type_contrat, solde_conges, hierarchy_path, management_scope, manager_id, date_naissance, email, telephone, adresse, contract_status, contrat_pdf_url, cv_url, id_card_url, diploma_url, attestation_url, lm_url";
    // On ajoute les colonnes financières UNIQUEMENT si l'utilisateur a le droit "Paie"
    if (checkPerm(req, "can_see_payroll")) {
      columns += ", salaire_brut_fixe, indemnite_transport, indemnite_logement";
    }

    let query = supabase.from("employees").select(columns, { count: "exact" });
    // ============================================================

    if (checkPerm(req, "can_see_employees")) {
      // Voit tout
    } else if (req.user.role === "MANAGER" && requester) {
      let conditions = [];
      const myPath = requester.hierarchy_path;
      conditions.push(`hierarchy_path.eq.${myPath}`);
      conditions.push(`hierarchy_path.ilike.${myPath}/%`);

      if (requester.management_scope?.length > 0) {
        const scopeList = `(${requester.management_scope.map((s) => `"${s}"`).join(",")})`;
        conditions.push(`departement.in.${scopeList}`);
      }
      query = query.or(conditions.join(","));
    } else {
      query = query.eq("id", currentUserId);
    }

    if (targetId) query = query.eq("id", targetId);
    if (search)
      query = query.or(`nom.ilike.%${search}%,matricule.ilike.%${search}%`);
    if (status !== "all") {
      if (status === "Actif") {
        query = query.in("statut", ["Actif", "En Poste"]);
      } else {
        query = query.eq("statut", status);
      }
    }
    if (type !== "all") query = query.eq("employee_type", type);
    if (dept !== "all") query = query.eq("departement", dept);
    if (roleFilter !== "all") query = query.eq("role", roleFilter);

    const { data, error, count } = await query
      .order("nom", { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    return res.json({
      data,
      meta: { total: count, page: page, last_page: Math.ceil(count / limit) },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.all("/emp-update", async (req, res) => {
  const { id, email, phone, address, dob, doc_type } = req.body;

  // 1. IDENTIFICATION SÉCURISÉE (Via Token JWT)
  const requesterId = String(req.user.emp_id);
  const targetId = String(id);
  const isOwner = requesterId === targetId;
  const isRH = req.user.permissions && req.user.permissions.can_see_employees;

  // 2. PREMIER FILTRE : QUI A LE DROIT D'ENTRER ?
  // Ni le propriétaire, ni un RH => Dehors.
  if (!isOwner && !isRH) {
    return res
      .status(403)
      .json({ error: "Interdit : Vous ne pouvez modifier que votre profil." });
  }

  console.log(
    `📝 Update ID ${targetId} (Type: ${doc_type}) par ${req.user.nom}`,
  );

  // 3. DEUXIÈME FILTRE : RESTRICTION DES DOCUMENTS
  // Liste des types que l'employé peut modifier seul
  const allowedForEmployee = ["text_update", "id_card", "photo"];

  // Si c'est l'employé (et qu'il n'est pas RH), on vérifie s'il touche à un doc interdit
  if (!isRH && !allowedForEmployee.includes(doc_type)) {
    console.error("🚫 Bloqué : L'employé tente de modifier un document RH");
    return res.status(403).json({
      error: "Modification interdite. Ce document est géré par les RH.",
    });
  }

  // --- LOGIQUE DE MISE À JOUR ---
  let updates = {};

  // Champs texte (Uniquement si envoyés)
  if (email) updates.email = email;
  if (phone) updates.telephone = phone;
  if (address) updates.adresse = address;
  if (dob) updates.date_naissance = dob;

// Gestion de l'upload de fichier (Photo ou Document)
  if (req.files && req.files.length > 0) {
    const file = req.files[0];
    if (file) {
      // Nomenclature : UPDATE_CV_ID45_TIMESTAMP.pdf
      const fileExt = file.originalname.split(".").pop();
      const fileName = `UPDATE_${doc_type.toUpperCase()}_ID${targetId}_${Date.now()}.${fileExt}`;
      // Upload vers Supabase Storage
      const { error: storageErr } = await supabase.storage
        .from("documents")
        .upload(fileName, file.buffer, { contentType: file.mimetype });

      if (storageErr) throw storageErr;

      const { data } = supabase.storage
        .from("documents")
        .getPublicUrl(fileName);

      // Mapping des colonnes en base de données
      if (doc_type === "text_update" || doc_type === "photo") updates.photo_url = data.publicUrl;
      else if (doc_type === "id_card") updates.id_card_url = data.publicUrl;
      else if (doc_type === "cv") updates.cv_url = data.publicUrl;
      else if (doc_type === "contrat") updates.contrat_pdf_url = data.publicUrl;
      else if (doc_type === "diploma") updates.diploma_url = data.publicUrl;
      else if (doc_type === "attestation") updates.attestation_url = data.publicUrl;

      // --- CORRECTION : ARCHIVAGE IMMÉDIAT ET SÉCURISÉ ---
      // On archive uniquement si ce n'est pas juste un texte
      if (doc_type !== "text_update") {
          // On s'assure d'avoir le nom de l'agent (depuis req.body si le token ne l'a pas)
          const agentName = req.body.agent || "Système RH";
          
          await supabase.from("employee_archives").insert([{
              employee_id: targetId,
              doc_type: doc_type,
              file_url: data.publicUrl, // On archive le NOUVEAU fichier
              agent: agentName
          }]);
          console.log(`🗄️ Document archivé : ${doc_type} pour ID ${targetId}`);
      }
    }
  }

  // Si rien à mettre à jour
  if (Object.keys(updates).length === 0) {
    return res.json({ status: "success", message: "Aucune modification détectée" });
  }

  // Exécution de la mise à jour (remplace la photo sur la page d'accueil)
  const { error } = await supabase
    .from("employees")
    .update(updates)
    .eq("id", targetId);

  if (error) {
    console.error("❌ Erreur Supabase Update:", error.message);
    throw error;
  }

  return res.json({ status: "success" });
});





// --- LIRE L'HISTORIQUE D'UN DOCUMENT ---
router.all("/read-archives", async (req, res) => {
    const { employee_id, doc_type } = req.query;
    if (!checkPerm(req, "can_view_employee_files") && req.user.emp_id !== employee_id) {
        return res.status(403).json({ error: "Accès refusé" });
    }
    
    const { data, error } = await supabase
        .from("employee_archives")
        .select("*")
        .eq("employee_id", employee_id)
        .eq("doc_type", doc_type)
        .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
});

// ============================================================
// 11. MISE À JOUR ADMINISTRATIVE (LOGIQUE PARTIELLE) ✅
// ============================================================
router.all("/update", async (req, res) => {
  if (!checkPerm(req, "can_see_employees")) {
    return res
      .status(403)
      .json({ error: "Accès refusé à l'administration des profils" });
  }

  const q = req.query; // Alias pour plus de clarté
  const id = q.id;
  const agent = q.agent;

  console.log(`🛠️ Mise à jour partielle pour ID ${id} par ${agent}`);

  // 1. On construit l'objet de mise à jour dynamiquement
  let updates = {};

  // Informations de base (seulement si présentes dans la requête)
  if (q.statut) updates.statut = q.statut;
  if (q.role) updates.role = q.role;
  if (q.dept) updates.departement = q.dept;
  if (q.employee_type) updates.employee_type = q.employee_type;
  if (q.poste) updates.poste = q.poste;

  // Gestion de la hiérarchie
  if (q.manager_id !== undefined) {
    updates.manager_id =
      q.manager_id === "null" || q.manager_id === "" ? null : q.manager_id;
  }
  if (q.scope) {
    try {
      updates.management_scope = JSON.parse(q.scope);
    } catch (e) {
      console.error("Erreur parse scope");
    }
  }

  // 2. LOGIQUE CONTRAT : Uniquement si demandé par le front-end
  if (q.recalculate_contract === "true") {
    updates.date_embauche = q.start_date;
    updates.type_contrat =
      q.limit === "365" ? "CDI" : q.limit === "180" ? "CDD" : "Essai";

    // On utilise la fonction de calcul de date de fin
    if (typeof getEndDate === "function") {
      updates.date_fin_contrat = getEndDate(q.start_date, q.limit);
    }
  }

  // 3. FINANCES (On vérifie si la valeur est fournie)
  if (q.salaire_brut_fixe !== undefined)
    updates.salaire_brut_fixe = parseFloat(q.salaire_brut_fixe) || 0;
  if (q.indemnite_transport !== undefined)
    updates.indemnite_transport = parseFloat(q.indemnite_transport) || 0;
  if (q.indemnite_logement !== undefined)
    updates.indemnite_logement = parseFloat(q.indemnite_logement) || 0;

  // 4. RÉINITIALISATION FORCÉE
  if (q.force_init === "true") {
    updates.solde_conges = 25;
    updates.contract_status = "Non signé";
  }

  // 5. Exécution de la mise à jour (Supabase n'écrase que les clés présentes dans 'updates')
  const { error } = await supabase
    .from("employees")
    .update(updates)
    .eq("id", id);

  if (error) {
    console.error("❌ Erreur Supabase Update:", error.message);
    throw error;
  }

  // Log d'audit
  await supabase.from("logs").insert([
    {
      agent: agent,
      action: "MODIF_ADMIN_PROFIL",
      details: `Champs modifiés pour l'ID ${id} : ${Object.keys(updates).join(", ")}`,
    },
  ]);

  return res.json({ status: "success", message: "Mise à jour effectuée." });
});

router.all("/delete-employee", async (req, res) => {
  // Vérification stricte de la permission Admin
  if (!checkPerm(req, "can_delete_employees")) {
    return res.status(403).json({
      error: "Accès refusé : Seul l'administrateur peut supprimer un profil.",
    });
  }

  const { id, agent } = req.body;

  try {
    // 1. Récupérer l'ID de l'utilisateur lié avant de supprimer l'employé
    const { data: emp, error: fetchErr } = await supabase
      .from("employees")
      .select("user_associated_id, nom")
      .eq("id", id)
      .single();

    if (fetchErr || !emp) throw new Error("Employé introuvable.");

    // 2. Supprimer l'employé de la table 'employees'
    // Note: Si tes clés étrangères sont en "CASCADE", cela supprimera ses pointages et congés automatiquement
    const { error: delEmpErr } = await supabase
      .from("employees")
      .delete()
      .eq("id", id);
    if (delEmpErr) throw delEmpErr;

    // 3. Supprimer le compte d'accès dans 'app_users'
    if (emp.user_associated_id) {
      await supabase
        .from("app_users")
        .delete()
        .eq("id", emp.user_associated_id);
    }

    // 4. Loguer l'action dans l'audit
    await supabase.from("logs").insert([
      {
        agent: agent,
        action: "SUPPRESSION_EMPLOYE",
        details: `Suppression définitive de ${emp.nom} (ID: ${id})`,
      },
    ]);

    return res.json({ status: "success" });
  } catch (err) {
    console.error("Erreur suppression:", err.message);
    return res.status(500).json({ error: err.message });
  }
});



// --- UPLOAD MASSIF (SCAN D'ARCHIVES) ---
router.all("/bulk-upload-docs", async (req, res) => {
  if (!checkPerm(req, "can_see_employees")) {
    return res.status(403).json({ error: "Accès refusé à la gestion documentaire." });
  }

  const empId = req.body.employee_id;
  const agent = req.body.agent || "RH";

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "Aucun fichier reçu." });
  }

  let updates = {};
  let archivesToInsert =[];

  try {
    for (const file of req.files) {
      // Le fieldname (ex: 'cv', 'id_card', 'contrat') définit le type de document
      const docType = file.fieldname; 
      const fileExt = file.originalname.split('.').pop();
      const fileName = `ARCHIVE_${docType.toUpperCase()}_ID${empId}_${Date.now()}.${fileExt}`;

      // 1. Upload dans Supabase Storage
      const { error: storageErr } = await supabase.storage
        .from("documents")
        .upload(fileName, file.buffer, { contentType: file.mimetype });

      if (storageErr) {
        console.error(`Erreur upload ${docType}:`, storageErr.message);
        continue; // On passe au fichier suivant en cas d'erreur
      }

      // 2. Récupération de l'URL publique
      const { data } = supabase.storage.from("documents").getPublicUrl(fileName);
      const fileUrl = data.publicUrl;

      // 3. On prépare la mise à jour du profil actif
      updates[`${docType}_url`] = fileUrl;
      // Cas particulier pour le contrat (nom de colonne différent)
      if (docType === 'contrat') updates[`contrat_pdf_url`] = fileUrl;

      // 4. On prépare l'insertion dans l'historique
      archivesToInsert.push({
        employee_id: empId,
        doc_type: docType,
        file_url: fileUrl,
        agent: agent
      });
    }

    // Sauvegarde en Base de Données
    if (Object.keys(updates).length > 0) {
      await supabase.from("employees").update(updates).eq("id", empId);
    }
    
    if (archivesToInsert.length > 0) {
      await supabase.from("employee_archives").insert(archivesToInsert);
    }

    return res.json({ status: "success", count: archivesToInsert.length });
  } catch (err) {
    console.error("Erreur Bulk Upload:", err.message);
    return res.status(500).json({ error: "Erreur lors de la numérisation massive." });
  }
});



// --- EXPORTER TOUT LE DOSSIER EN ZIP ---
router.get("/export-folder/:id", async (req, res) => {
    if (!checkPerm(req, "can_view_employee_files") && !checkPerm(req, "can_see_employees")) {
        return res.status(403).json({ error: "Accès refusé" });
    }

    const empId = req.params.id;

    try {
        // 1. Récupération TOTALE des données
        const [empRes, archivesRes, paieRes, congesRes, candidaturesRes] = await Promise.all([
            supabase.from("employees").select("*").eq("id", empId).single(),
            supabase.from("employee_archives").select("*").eq("employee_id", empId),
            supabase.from("paie").select("*").eq("employee_id", empId),
            supabase.from("conges").select("*").eq("employee_id", empId),
            supabase.from("candidatures").select("*").eq("email", "REMPLACER_PAR_EMAIL_OU_ID_SI_LIEN") // Optionnel selon ta BDD
        ]);

        const emp = empRes.data;
        if (!emp) return res.status(404).json({ error: "Employé introuvable" });

        const cleanName = emp.nom.replace(/[^a-zA-Z0-9]/g, "_");
        const zipFilename = `Dossier_RH_${emp.matricule}_${cleanName}.zip`;

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename=${zipFilename}`);

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);

        // Fonction helper pour ajouter au zip
        const addFileToZip = async (url, folderName, customFilename) => {
            if (!url || url === "null" || url.length < 5) return;
            try {
                const response = await axios.get(url, { responseType: 'stream' });
                const ext = url.split('.').pop().split('?')[0] || 'pdf';
                archive.append(response.data, { name: `${folderName}/${customFilename}.${ext}` });
            } catch (e) { console.warn(`Fichier absent ou inaccessible: ${customFilename}`); }
        };

        // --- DOSSIER 0 : IDENTITÉ & PHOTO ---
        await addFileToZip(emp.photo_url, "0_Identite_et_Photo", "Photo_Profil");

        // --- DOSSIER 1 : ADMINISTRATIF ---
        const dirAdmin = "1_Dossier_Administratif";
        await addFileToZip(emp.contrat_pdf_url, dirAdmin, "Contrat_Actuel");
        await addFileToZip(emp.id_card_url, dirAdmin, "Piece_Identite");
        await addFileToZip(emp.cv_url, dirAdmin, "CV");
        await addFileToZip(emp.diploma_url, dirAdmin, "Diplome");
        await addFileToZip(emp.attestation_url, dirAdmin, "Attestation");

        // --- DOSSIER 2 : HISTORIQUE DES DOCUMENTS ---
        if (archivesRes.data) {
            for (const arc of archivesRes.data) {
                const date = arc.created_at.split('T')[0];
                await addFileToZip(arc.file_url, "2_Historique_Documents", `${arc.doc_type}_${date}`);
            }
        }

        // --- DOSSIER 3 : PAIE ---
        if (paieRes.data) {
            for (const p of paieRes.data) {
                await addFileToZip(p.fiche_pdf_url, "3_Bulletins_Paie", `Bulletin_${p.annee}_${p.mois}`);
            }
        }

        // --- DOSSIER 4 : CONGÉS ET ABSENCES (Avec récap texte) ---
        if (congesRes.data) {
            let recap = `RAPPORT DES CONGÉS - ${emp.nom}\nMatricule: ${emp.matricule}\n\n`;
            for (const c of congesRes.data) {
                recap += `Type: ${c.type} | Date: ${c.date_debut} au ${c.date_fin} | Statut: ${c.statut}\n`;
                recap += `Motif: ${c.motif}\n------------------\n`;
                if (c.justificatif_url) await addFileToZip(c.justificatif_url, "4_Conges_Justificatifs", `Justificatif_${c.date_debut}`);
            }
            archive.append(recap, { name: "4_Conges_Justificatifs/Recapitulatif_Absences.txt" });
        }

        await archive.finalize();

    } catch (err) {
        console.error("Erreur Export ZIP:", err);
        res.status(500).json({ error: "Erreur lors de la création du ZIP." });
    }
});
module.exports = router;
