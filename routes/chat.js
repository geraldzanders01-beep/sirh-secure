const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const { checkPerm } = require("../utils");

router.all("/read-messages", async (req, res) => {
  // On récupère les 50 derniers messages + les infos de l'expéditeur (nom, photo)
  const { data, error } = await supabase
    .from("messages")
    .select("*, employees(id, nom, photo_url)")
    .order("created_at", { ascending: true }) // Chronologique (anciens -> récents)
    .limit(50);

  if (error) throw error;

  // On formate pour le frontend
  const mapped = data.map((m) => ({
    id: m.id,
    message: m.message,
    file: m.file_url,
    date: m.created_at,
    sender_id: m.sender_id,
    // Si l'employé a été supprimé, on met "Inconnu"
    sender_name: m.employees ? m.employees.nom : "Utilisateur supprimé",
    sender_photo: m.employees ? m.employees.photo_url : null,
  }));

  return res.json(mapped);
});

router.all("/send-message", async (req, res) => {
  if (!checkPerm(req, "can_use_chat"))
    return res
      .status(403)
      .json({ error: "Interdit : Accès au chat désactivé." });

  // On force l'utilisation de l'ID du token pour garantir l'identité
  const sender_id = req.user.emp_id;
  let { message } = req.body;
  message = message.replace(/<[^>]*>?/gm, "");

  let fileUrl = null;

  console.log(`💬 Message de ${sender_id} en cours de traitement...`);

  const file = req.files
    ? req.files.find((f) => f.fieldname === "chat_file")
    : null;

  if (file) {
    const maxSize = 5 * 1024 * 1024;
    if (file.size > maxSize) {
      console.error("❌ Erreur : Fichier trop volumineux.");
      return res.json({
        status: "error",
        message: "Le fichier est trop lourd (max 5 Mo).",
      });
    }

    const sanitizedName = file.originalname
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9.]/gi, "_");

    const fileName = `chat_${Date.now()}_${sanitizedName}`;

    console.log(`📎 Upload du fichier sécurisé : ${fileName}`);

    const { data: uploadData, error: upErr } = await supabase.storage
      .from("documents")
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (upErr) {
      console.error("❌ Erreur Storage Supabase:", upErr.message);
    } else {
      const { data: publicData } = supabase.storage
        .from("documents")
        .getPublicUrl(fileName);

      fileUrl = publicData.publicUrl;
      console.log("✅ URL générée avec succès :", fileUrl);
    }
  }

  const { error: dbErr } = await supabase.from("messages").insert([
    {
      sender_id: sender_id,
      message: message || "",
      file_url: fileUrl,
    },
  ]);

  if (dbErr) {
    console.error("❌ Erreur BDD Messages:", dbErr.message);
    return res.status(500).json({ error: dbErr.message });
  }

  return res.json({ status: "success" });
});

module.exports = router;
