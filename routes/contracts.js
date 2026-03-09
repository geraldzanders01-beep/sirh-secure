const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const { checkPerm } = require("../utils");
const axios = require("axios");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const ImageModule = require("docxtemplater-image-module-free");
const libre = require("libreoffice-convert");
const { promisify } = require("util");
const convertAsync = promisify(libre.convert);
const pLimit = require("p-limit");
const pdfLimiter = pLimit(1);
const SIGNATURE_PLACEHOLDER =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASwAAABAAQMAAAB6pZ9hAAAABlBMVEX///9BQUFE6v9pAAAAAXRSTlMAQObYZgAAADxJREFUeF7t0CERAAAIAzH86Bv7m8MEpInZ7mYpSUn6pCTpSUnSk5KkJyVJT0qSnpQkPSlJelKS9KQk6UmfBy68B9Vv999FAAAAAElFTkSuQmCC";

// --- LISTER LES MODÈLES (Pour le formulaire d'embauche) ---
router.all("/list-templates", async (req, res) => {
  const { data, error } = await supabase
    .from("contract_templates")
    .select("*")
    .eq("is_active", true) // <--- Crucial : on ne propose que les modèles actuels
    .order("label", { ascending: true });

  if (error) throw error;
  return res.json(data);
});

// --- UPLOADER UN NOUVEAU MODÈLE DOCX ---
router.all("/upload-template", async (req, res) => {
  if (!checkPerm(req, "can_manage_config"))
    return res.status(403).json({ error: "Accès refusé." });

  const { role_target, label } = req.body;
  const file = req.files[0]; // Le fichier Word

  if (!role_target || !file)
    return res.status(400).json({ error: "Infos manquantes" });

  // 1. Upload du fichier dans le bucket 'documents'
  const fileName = `template_${role_target}_${Date.now()}.docx`;
  const { error: upErr } = await supabase.storage
    .from("documents")
    .upload(fileName, file.buffer, { contentType: file.mimetype });

  if (upErr) throw upErr;

  // 2. Récupération de l'URL publique
  const { data } = supabase.storage.from("documents").getPublicUrl(fileName);

  // 3. Enregistrement en base (Upsert pour mettre à jour si le rôle existe déjà)
  const { error: dbErr } = await supabase.from("contract_templates").upsert(
    {
      role_target: role_target,
      label: label,
      template_file_url: data.publicUrl,
      is_active: true,
    },
    { onConflict: "role_target" },
  );

  if (dbErr) throw dbErr;

  return res.json({ status: "success" });
});

router.all("/contract-gen", async (req, res) => {
  if (!checkPerm(req, "can_see_employees")) {
    return res.status(403).json({ error: "Accès refusé." });
  }

  const { id } = req.query;

  try {
    // 1. Récupération des données
    const { data: emp, error } = await supabase
      .from("employees")
      .select("*")
      .eq("id", id)
      .single();
    if (error || !emp) throw new Error("Employé introuvable");

    // 2. RECHERCHE INTELLIGENTE DU MODÈLE (CORRECTIONS)
    let templateData = null;

    // Tentative A : Par l'ID technique du modèle (si sélectionné à la création)
    if (emp.contract_template_id) {
      const { data: byId } = await supabase
        .from("contract_templates")
        .select("template_file_url")
        .eq("id", emp.contract_template_id)
        .maybeSingle();
      templateData = byId;
    }

    // Tentative B : Par le Rôle si A n'a rien donné
    if (!templateData) {
      const { data: byRole } = await supabase
        .from("contract_templates")
        .select("template_file_url")
        .eq("role_target", emp.role || "EMPLOYEE")
        .maybeSingle();
      templateData = byRole;
    }

    if (!templateData || !templateData.template_file_url) {
      throw new Error(
        "Aucun modèle de contrat configuré pour ce rôle ou cet ID.",
      );
    }

    // 3. Téléchargement et Remplissage du Word
    const fileResponse = await axios.get(templateData.template_file_url, {
      responseType: "arraybuffer",
    });
    const zip = new PizZip(fileResponse.data);

    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      nullGetter() {
        return " ";
      },
    });

    let dateFinCalculee = "Indéterminée";
    const joursContrat = parseInt(emp.type_contrat); // On récupère 90, 180 ou 365

    if (joursContrat < 365 && emp.date_embauche) {
      const dateFin = new Date(emp.date_embauche);
      dateFin.setDate(dateFin.getDate() + joursContrat);
      dateFinCalculee = dateFin.toLocaleDateString("fr-FR");
    }

    const now = new Date();
    const dataToInject = {
      civilite: emp.civilite || "Monsieur/Madame",
      nom_complet: emp.nom,
      poste: emp.poste || "Collaborateur",
      matricule: emp.matricule || "N/A",
      adresse: emp.adresse || "Non renseignée",
      type_contrat: emp.type_contrat || "Essai",
      departement: emp.departement || "Général",
      employee_type: emp.employee_type || "OFFICE",

      // Dates et Durées
      date_embauche: emp.date_embauche
        ? new Date(emp.date_embauche).toLocaleDateString("fr-FR")
        : "---",
      date_fin: dateFinCalculee,
      duree_essai: emp.duree_essai || "3 mois",

      // Identité
      lieu_naissance: emp.lieu_naissance || "---",
      nationalite: emp.nationalite || "Béninoise",
      temps_travail: emp.temps_travail || "40h",

      // Finances
      salaire_base: new Intl.NumberFormat("fr-FR").format(
        emp.salaire_brut_fixe || 0,
      ),
      transport: new Intl.NumberFormat("fr-FR").format(
        emp.indemnite_transport || 0,
      ),
      logement: new Intl.NumberFormat("fr-FR").format(
        emp.indemnite_logement || 0,
      ),

      // Signature
      lieu_signature: emp.lieu_signature || "Cotonou",
      date_jour: now.toLocaleDateString("fr-FR", {
        day: "numeric",
        month: "long",
        year: "numeric",
      }),
      signature: SIGNATURE_PLACEHOLDER,
    };

    doc.render(dataToInject);
    const docxBuffer = doc
      .getZip()
      .generate({ type: "nodebuffer", compression: "DEFLATE" });

    // 4. CONVERSION EN PDF POUR LA VUE
    console.log("🔄 Conversion du brouillon en PDF...");
    const pdfBuffer = await pdfLimiter(() =>
      convertAsync(docxBuffer, ".pdf", undefined),
    );
    // 5. ENVOI DU PDF AU NAVIGATEUR
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "inline; filename=Brouillon_Contrat.pdf",
    );
    res.send(pdfBuffer);
  } catch (err) {
    console.error("Erreur Brouillon PDF:", err);
    res.status(500).json({ error: err.message });
  }
});

router.all("/contract-upload", async (req, res) => {
  // SÉCURITÉ STRICTE
  if (!checkPerm(req, "can_see_employees")) {
    return res
      .status(403)
      .json({ error: "Action non autorisée. Veuillez voir avec les RH." });
  }

  const { id, signature } = req.body;
  let contractUrl = "";

  // 1. Récupération des données complètes de l'employé
  const { data: emp, error } = await supabase
    .from("employees")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !emp)
    return res.status(404).json({ error: "Employé introuvable" });

  // --- CAS A : UPLOAD MANUEL (SCAN PHYSIQUE / PDF / PHOTO) ---
  if (req.files && req.files.length > 0) {
    console.log("📁 Réception d'un contrat scanné...");
    const file = req.files[0];
    const fileExt = file.originalname.split(".").pop();
    const fileName = `contrat_physique_${id}_${Date.now()}.${fileExt}`;

    const { error: storageErr } = await supabase.storage
      .from("documents")
      .upload(fileName, file.buffer, { contentType: file.mimetype });

    if (storageErr) throw storageErr;
    contractUrl = supabase.storage.from("documents").getPublicUrl(fileName)
      .data.publicUrl;
  }

  // --- CAS B : SIGNATURE ÉLECTRONIQUE (DOCX -> PDF) ---
  else if (signature) {
    console.log("✍️ Signature et Conversion PDF en cours...");

    try {
      // --- RECHERCHE INTELLIGENTE DU MODÈLE (CORRECTIONS ICI) ---
      let templateData = null;

      // Tentative A : Par l'ID technique du modèle
      if (emp.contract_template_id) {
        const { data: byId } = await supabase
          .from("contract_templates")
          .select("template_file_url")
          .eq("id", emp.contract_template_id)
          .maybeSingle();
        templateData = byId;
      }

      // Tentative B : Par le Rôle (ou défaut EMPLOYEE)
      if (!templateData) {
        const { data: byRole } = await supabase
          .from("contract_templates")
          .select("template_file_url")
          .eq("role_target", emp.role || "EMPLOYEE")
          .maybeSingle();
        templateData = byRole;
      }

      if (!templateData || !templateData.template_file_url) {
        throw new Error(
          "Modèle de contrat introuvable. Veuillez vérifier vos modèles DOCX.",
        );
      }
      // --- FIN DE LA CORRECTION DE RECHERCHE ---

      // 2. Récupération du modèle Word
      const fileResponse = await axios.get(templateData.template_file_url, {
        responseType: "arraybuffer",
      });
      const zip = new PizZip(fileResponse.data);

      // 3. Module Image pour la Signature
      const imageModule = new ImageModule({
        centered: false,
        getImage: function (tagValue) {
          const base64Data = tagValue.replace(/^data:image\/\w+;base64,/, "");
          return Buffer.from(base64Data, "base64");
        },
        getSize: function (img, tagValue) {
          if (tagValue === SIGNATURE_PLACEHOLDER) {
            return [300, 80];
          }
          return [180, 70];
        },
      });

      // 4. Remplissage du document
      const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
        modules: [imageModule],
        nullGetter() {
          return " ";
        },
      });

      const now = new Date();

      let dateFinCalculee = "Indéterminée";
      const joursContrat = parseInt(emp.type_contrat);

      if (joursContrat < 365 && emp.date_embauche) {
        const dateFin = new Date(emp.date_embauche);
        dateFin.setDate(dateFin.getDate() + joursContrat);
        dateFinCalculee = dateFin.toLocaleDateString("fr-FR");
      }

      const dataToInject = {
        civilite: emp.civilite || "Monsieur/Madame",
        nom_complet: emp.nom,
        poste: emp.poste || "Collaborateur",
        matricule: emp.matricule || "N/A",
        adresse: emp.adresse || "Non renseignée",
        type_contrat: emp.type_contrat || "Essai",
        departement: emp.departement || "Général",
        employee_type: emp.employee_type || "OFFICE",
        date_embauche: emp.date_embauche
          ? new Date(emp.date_embauche).toLocaleDateString("fr-FR")
          : "---",
        date_fin: dateFinCalculee,
        duree_essai: emp.duree_essai || "3 mois",
        lieu_naissance: emp.lieu_naissance || "---",
        nationalite: emp.nationalite || "Béninoise",
        temps_travail: emp.temps_travail || "40h",
        salaire_base: new Intl.NumberFormat("fr-FR").format(
          emp.salaire_brut_fixe || 0,
        ),
        transport: new Intl.NumberFormat("fr-FR").format(
          emp.indemnite_transport || 0,
        ),
        logement: new Intl.NumberFormat("fr-FR").format(
          emp.indemnite_logement || 0,
        ),
        lieu_signature: emp.lieu_signature || "Cotonou",
        date_jour: now.toLocaleDateString("fr-FR", {
          day: "numeric",
          month: "long",
          year: "numeric",
        }),
        signature: signature,
      };

      doc.render(dataToInject);

      // 5. Conversion Word -> PDF
      const docxBuffer = doc
        .getZip()
        .generate({ type: "nodebuffer", compression: "DEFLATE" });

      console.log("🔄 Lancement de la conversion LibreOffice...");
      const pdfBuffer = await pdfLimiter(() =>
        convertAsync(docxBuffer, ".pdf", undefined),
      );
      // 6. Upload du PDF final
      const pdfFileName = `contrat_signe_${id}_${Date.now()}.pdf`;
      const { error: upErr } = await supabase.storage
        .from("documents")
        .upload(pdfFileName, pdfBuffer, { contentType: "application/pdf" });

      if (upErr) throw upErr;
      contractUrl = supabase.storage.from("documents").getPublicUrl(pdfFileName)
        .data.publicUrl;
    } catch (err) {
      console.error("❌ Erreur Processus Contrat:", err);
      return res.status(500).json({
        error: "Échec de la génération du contrat PDF : " + err.message,
      });
    }
  }

  // --- MISE À JOUR COMMUNE (Statut & URL) ---
  if (contractUrl) {
    await supabase
      .from("employees")
      .update({
        contract_status: "Signé",
        contrat_pdf_url: contractUrl,
      })
      .eq("id", id);


    // --- NOUVEAU : ARCHIVER LE CONTRAT SIGNÉ ---
    await supabase.from("employee_archives").insert([{
        employee_id: id,
        doc_type: "contrat",
        file_url: contractUrl,
        agent: req.user.nom || "Système"
    }]);
    
    return res.json({ status: "success", url: contractUrl });
  } else {
    return res
      .status(400)
      .json({ error: "Aucune donnée de contrat ou signature reçue." });
  }
});

router.all("/delete-template", async (req, res) => {
  const { id } = req.body;

  const { error } = await supabase
    .from("contract_templates")
    .update({ is_active: false })
    .eq("id", id);

  if (error) throw error;
  return res.json({ status: "success", message: "Modèle archivé" });
});

module.exports = router;
