const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const { checkPerm, sendPushNotification } = require("../utils"); 


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

  const sender_emp_id = req.user.emp_id; // ID Employé (pour la table messages)
  const sender_user_id = req.user.id;   // ID Utilisateur (pour exclure de la notif)
  const sender_name = req.user.nom;     // Nom de l'expéditeur (pour le titre de la notif)

  let { message } = req.body;
  message = message ? message.replace(/<[^>]*>?/gm, "") : "";

  let fileUrl = null;

  // --- LOGIQUE FICHIER (Inchangée) ---
  const file = req.files ? req.files.find((f) => f.fieldname === "chat_file") : null;

  if (file) {
    const fileName = `chat_${Date.now()}_${file.originalname.replace(/[^a-z0-9.]/gi, "_")}`;
    const { error: upErr } = await supabase.storage
      .from("documents")
      .upload(fileName, file.buffer, { contentType: file.mimetype, upsert: true });

    if (!upErr) {
      const { data: publicData } = supabase.storage.from("documents").getPublicUrl(fileName);
      fileUrl = publicData.publicUrl;
    }
  }

  // --- INSERTION EN BASE DE DONNÉES ---
  const { error: dbErr } = await supabase.from("messages").insert([
    {
      sender_id: sender_emp_id,
      message: message || "",
      file_url: fileUrl,
    },
  ]);

  if (dbErr) {
    return res.status(500).json({ error: dbErr.message });
  }

  // ============================================================
  // 🔥 NOUVEAU : DÉCLENCHEMENT DES NOTIFICATIONS PUSH
  // ============================================================
  try {
    // 1. On récupère la liste de tous les IDs utilisateurs sauf l'expéditeur
    const { data: recipients } = await supabase
      .from('app_users')
      .select('id')
      .neq('id', sender_user_id);

    if (recipients && recipients.length > 0) {
      const notificationTitle = `Nouveau message de ${sender_name}`;
      const notificationBody = message || "📁 A envoyé un fichier...";
      const notificationUrl = "/#chat";

      // 2. On envoie la notif à tout le monde en arrière-plan
      recipients.forEach(user => {
        sendPushNotification(user.id, notificationTitle, notificationBody, notificationUrl);
      });
    }
  } catch (pushErr) {
    console.error("Erreur lors de l'envoi des notifs push chat:", pushErr);
    // On ne bloque pas la réponse 'success' si les notifs échouent
  }

  return res.json({ status: "success" });
});

module.exports = router;
