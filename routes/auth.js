const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const supabase = require("../supabaseClient");
const { sendEmailAPI } = require("../utils");
const JWT_SECRET = process.env.JWT_SECRET;

// 1. LOGIN SÉCURISÉ (AVEC BLOCAGE DES SORTANTS)
router.all("/login", async (req, res) => {
  const username = req.body.u || req.query.u;
  const password = req.body.p || req.query.p;

  // Récupération de l'utilisateur et de son rôle
  const { data: user, error } = await supabase
    .from("app_users")
    .select(
      "id, email, password, nom_complet, employees(id, role, photo_url, statut, employee_type)",
    )
    .eq("email", username)
    .single();

  // VÉRIFICATION 1 : Identifiants corrects ?
  if (error || !user || user.password !== password) {
    return res.json({
      status: "error",
      message: "Identifiant ou mot de passe incorrect",
    });
  }

  const emp =
    user.employees && user.employees.length > 0 ? user.employees[0] : null;

  // VÉRIFICATION 2 : Est-ce un compte orphelin ? (Sauf si Admin système)
  if (!emp && username !== "admin@tondomaine.com") {
    return res.json({
      status: "error",
      message: "Compte utilisateur non lié à une fiche employé",
    });
  }

  // VÉRIFICATION 3 : LE "KILL SWITCH" (MODIFIÉ POUR ÊTRE EXPLICITE)
  if (emp) {
    const statut = (emp.statut || "").trim().toLowerCase();
    // On vérifie si le statut contient "Sortie"
    if (statut.includes("sortie")) {
      console.warn(`⛔ Accès bloqué (Compte Révoqué) : ${user.nom_complet}`);
      return res.json({
        status: "revoked", // On change le statut ici
        message:
          "Accès révoqué - STATUS : SORTIE . Veuillez contacter la direction ou les RH ..",
      });
    }
  }

  const userRole = emp
    ? (emp.role || "EMPLOYEE").toUpperCase().trim()
    : "EMPLOYEE";

  // --- RÉCUPÉRATION DES DROITS ---
  const { data: perms } = await supabase
    .from("role_permissions")
    .select("*")
    .eq("role_name", userRole)
    .single();

  const token = jwt.sign(
    {
      id: user.id,
      emp_id: emp ? emp.id : null,
      role: userRole,
      permissions: perms || {},
      hierarchy_path: emp ? emp.hierarchy_path : null,
      management_scope: emp ? emp.management_scope : [],
    },
    JWT_SECRET,
    { expiresIn: "8h" },
  );

  return res.json({
    status: "success",
    token: token,
    id: emp ? emp.id : null,
    nom: user.nom_complet,
    role: userRole,
    photo: emp ? emp.photo_url : null,
    employee_type: emp ? emp.employee_type : "OFFICE",
    permissions: perms || {},
  });
});

// A. DEMANDER UN CODE (VERSION SÉCURISÉE)
router.all("/request-password-reset", async (req, res) => {
  const email = req.body.email ? req.body.email.toLowerCase().trim() : "";
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = new Date(Date.now() + 15 * 60000).toISOString(); // On réduit à 15 min (plus sûr)

  // 1. On tente de mettre à jour l'utilisateur s'il existe
  const { data: user, error } = await supabase
    .from("app_users")
    .update({ reset_code: code, reset_expires: expires })
    .eq("email", email)
    .select("nom_complet")
    .maybeSingle();

  // 2. S'il existe, on envoie le mail
  if (user) {
    const html = `
                    <div style="font-family: sans-serif; color: #1e293b; padding: 20px; border: 1px solid #e2e8f0; border-radius: 15px;">
                        <h2 style="color: #2563eb;">Sécurité SIRH</h2>
                        <p>Bonjour <b>${user.nom_complet}</b>,</p>
                        <p>Vous avez demandé la réinitialisation de votre mot de passe. Voici votre code de vérification :</p>
                        <div style="background: #f1f5f9; padding: 15px; text-align: center; font-size: 24px; font-weight: 900; letter-spacing: 5px; color: #0f172a; border-radius: 10px; margin: 20px 0;">
                            ${code}
                        </div>
                        <p style="font-size: 12px; color: #64748b;">Ce code expirera dans 15 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.</p>
                    </div>`;

    await sendEmailAPI(email, "Code de sécurité SIRH", html);
  }

  // 3. ON RÉPOND TOUJOURS SUCCÈS (Pour brouiller les pistes des pirates)
  return res.json({ status: "success", message: "Procédure lancée." });
});

// B. VALIDER LE CHANGEMENT (VERSION BLINDÉE)
router.all("/reset-password", async (req, res) => {
  const { email, code, newPassword } = req.body;
  const cleanEmail = email.toLowerCase().trim();

  // 1. Vérification stricte : Email + Code + Expiration
  const { data: user, error } = await supabase
    .from("app_users")
    .select("id")
    .eq("email", cleanEmail)
    .eq("reset_code", code)
    .gt("reset_expires", new Date().toISOString())
    .maybeSingle();

  if (!user) {
    return res.status(400).json({ error: "Code invalide ou expiré." });
  }

  // 2. Mise à jour du mot de passe ET destruction du code
  const { error: updateErr } = await supabase
    .from("app_users")
    .update({
      password: newPassword,
      reset_code: null, // On efface le code pour qu'il ne resserve plus
      reset_expires: null, // On efface l'expiration
    })
    .eq("id", user.id);

  if (updateErr) throw updateErr;

  // 3. Log de sécurité
  await supabase.from("logs").insert([
    {
      agent: "Système",
      action: "SÉCURITÉ",
      details: `Mot de passe réinitialisé pour : ${cleanEmail}`,
    },
  ]);

  return res.json({ status: "success" });
});

module.exports = router;
