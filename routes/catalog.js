const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const { checkPerm } = require("../utils");

router.all("/save-product", async (req, res) => {
  if (!checkPerm(req, "can_manage_config"))
    return res.status(403).json({ error: "Accès refusé." });

  const { id, name, description } = req.body;
  let finalUrls = [];

  // 1. Si c'est une modification, on récupère d'abord les photos déjà existantes en base
  if (id && id !== "null" && id !== "") {
    const { data: current } = await supabase
      .from("products")
      .select("photo_urls")
      .eq("id", id)
      .single();
    if (current && current.photo_urls) {
      finalUrls = Array.isArray(current.photo_urls) ? current.photo_urls : [];
    }
  }

  // 2. On traite les nouveaux fichiers envoyés (s'il y en a)
  if (req.files && req.files.length > 0) {
    for (const file of req.files) {
      const fileName = `prod_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
      const { error: upErr } = await supabase.storage
        .from("documents")
        .upload(fileName, file.buffer, { contentType: file.mimetype });

      if (!upErr) {
        const { data } = supabase.storage
          .from("documents")
          .getPublicUrl(fileName);
        finalUrls.push(data.publicUrl); // On ajoute le nouveau lien au tableau
      }
    }
  }

  const payload = {
    name: name,
    description: description,
    photo_urls: finalUrls, // Tableau JSON
    is_active: true,
  };

  let result;
  if (id && id !== "null" && id !== "") {
    // C'est une mise à jour
    result = await supabase.from("products").update(payload).eq("id", id);
  } else {
    // C'est une nouvelle création
    result = await supabase.from("products").insert([payload]);
  }

  if (result.error) throw result.error;
  return res.json({ status: "success" });
});

// --- AJOUTER UN PRESCRIPTEUR (ADMIN/MANAGER) ---
router.all("/add-prescripteur", async (req, res) => {
  if (!checkPerm(req, "can_manage_prescripteurs")) {
    return res.status(403).json({
      error:
        "Accès refusé : Vous n'êtes pas autorisé à créer des prescripteurs.",
    });
  }

  const { nom_complet, fonction, telephone, location_id } = req.body;

  // On vérifie si un médecin avec ce nom existe déjà (pour éviter les doublons)
  const { data: exist } = await supabase
    .from("prescripteurs")
    .select("id")
    .ilike("nom_complet", nom_complet)
    .maybeSingle();

  if (exist) {
    return res
      .status(400)
      .json({ error: "Ce prescripteur existe déjà dans la base." });
  }

  const { error } = await supabase.from("prescripteurs").insert([
    {
      nom_complet,
      fonction,
      telephone,
      location_id: location_id || null,
      is_active: true,
    },
  ]);

  if (error) throw error;
  return res.json({ status: "success" });
});

// --- SUPPRIMER (DÉSACTIVER) UN PRESCRIPTEUR ---
router.all("/delete-prescripteur", async (req, res) => {
  if (!req.user.permissions || !req.user.permissions.can_manage_config) {
    return res.status(403).json({ error: "Accès refusé." });
  }
  const { id } = req.body;
  // On ne supprime pas physiquement pour garder l'historique des rapports, on désactive
  const { error } = await supabase
    .from("prescripteurs")
    .update({ is_active: false })
    .eq("id", id);

  if (error) throw error;
  return res.json({ status: "success" });
});

// --- MODIFIER UN PRESCRIPTEUR ---
router.all("/update-prescripteur", async (req, res) => {
  if (!req.user.permissions || !req.user.permissions.can_manage_config) {
    return res.status(403).json({ error: "Accès refusé." });
  }

  const { id, nom_complet, fonction, telephone, location_id } = req.body;

  const { error } = await supabase
    .from("prescripteurs")
    .update({
      nom_complet,
      fonction,
      telephone,
      location_id: location_id || null,
    })
    .eq("id", id);

  if (error) throw error;
  return res.json({ status: "success" });
});

// --- LISTER LES PRESCRIPTEURS OFFICIELS ---
router.all("/list-prescripteurs", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("prescripteurs")
      .select("*")
      .eq("is_active", true)
      .order("nom_complet", { ascending: true });

    if (error) throw error;
    return res.json(data);
  } catch (err) {
    console.error("Erreur list-prescripteurs:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// --- IMPORT MASSIF DE PRESCRIPTEURS (CSV) ---
router.all("/import-prescripteurs", async (req, res) => {
  if (!checkPerm(req, "can_manage_prescripteurs")) {
    return res.status(403).json({ error: "Interdit : Droits insuffisants." });
  }

  const { prescripteurs } = req.body;

  // Insertion massive (Supabase gère très bien ça)
  const { error } = await supabase.from("prescripteurs").insert(prescripteurs);

  if (error) {
    console.error("Erreur Import Prescripteurs:", error.message);
    throw error;
  }
  return res.json({ status: "success", count: prescripteurs.length });
});

// --- LISTER LES PRODUITS (AVEC MULTI-PHOTOS) ---
router.all("/list-products", async (req, res) => {
  const { data, error } = await supabase
    .from("products")
    .select("id, name, description, photo_urls") // On demande le tableau JSON
    .eq("is_active", true)
    .order("name");
  if (error) throw error;
  return res.json(data);
});

// --- SUPPRIMER UN PRODUIT (Désactivation) ---
router.all("/delete-product", async (req, res) => {
  if (!checkPerm(req, "can_manage_config"))
    return res.status(403).json({ error: "Accès refusé." });
  const { id } = req.body;
  const { error } = await supabase
    .from("products")
    .update({ is_active: false })
    .eq("id", id);
  if (error) throw error;
  return res.json({ status: "success" });
});

module.exports = router;
