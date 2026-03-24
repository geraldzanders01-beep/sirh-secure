const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const supabase = require("../supabaseClient");
const { sendEmailAPI } = require("../utils");
const JWT_SECRET = process.env.JWT_SECRET;

// 1. LOGIN AVEC 2FA CONDITIONNEL
router.all("/login", async (req, res) => {
  const username = (req.body.u || req.query.u || "").toLowerCase().trim();
  const password = req.body.p || req.query.p;

  // 1. Récupération de l'utilisateur
  const { data: user, error } = await supabase
    .from("app_users")
    .select("id, email, password, nom_complet, employees(id, role, statut, photo_url, employee_type)")
    .eq("email", username)
    .single();

  if (error || !user || user.password !== password) {
    return res.json({ status: "error", message: "Identifiants incorrects" });
  }

  const emp = user.employees && user.employees.length > 0 ? user.employees[0] : null;
  const userRole = emp ? (emp.role || "EMPLOYEE").toUpperCase() : "EMPLOYEE";

  // --- SÉCURITÉ : BLOCAGE DES SORTIES ---
  if (emp && emp.statut.toLowerCase().includes("sortie")) {
    return res.json({ status: "revoked", message: "Accès révoqué. Contactez la direction." });
  }

  // ============================================================
  // 🔥 LOGIQUE 2FA POUR ADMIN & RH
  // ============================================================
  if (userRole === "ADMIN" || userRole === "RH") {
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 10 * 60000).toISOString(); // Expire dans 10 min

    // On stocke le code dans app_users (colonnes reset_code et reset_expires)
    await supabase.from("app_users")
      .update({ reset_code: otpCode, reset_expires: expires })
      .eq("id", user.id);

    // Email Premium Harmonisé
    const emailHtml = `
    <div style="font-family: sans-serif; color: #1e293b; max-width: 500px; margin: auto; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden;">
        <div style="background-color: #0f172a; padding: 30px; text-align: center;">
            <img src="https://cdn-icons-png.flaticon.com/512/9752/9752284.png" style="width: 60px;">
            <h1 style="color: #ffffff; margin: 10px 0 0 0; font-size: 18px; letter-spacing: 2px;">SÉCURITÉ SIRH</h1>
        </div>
        <div style="padding: 40px; text-align: center;">
            <h2 style="margin-top: 0; color: #0f172a;">Vérification de connexion</h2>
            <p style="color: #64748b;">Un accès à privilèges élevés a été demandé pour votre compte. Utilisez le code ci-dessous pour valider votre identité :</p>
            <div style="background: #f1f5f9; padding: 20px; margin: 30px 0; font-size: 32px; font-weight: 900; letter-spacing: 10px; color: #2563eb; border-radius: 12px; border: 2px dashed #cbd5e1; font-family: monospace;">
                ${otpCode}
            </div>
            <p style="font-size: 12px; color: #94a3b8;">Ce code expirera dans 10 minutes. Si vous n'êtes pas à l'origine de cette demande, sécurisez votre compte immédiatement.</p>
        </div>
    </div>`;

    await sendEmailAPI(user.email, "Votre code de sécurité SIRH", emailHtml);

    return res.json({ status: "require_2fa", email: user.email });
  }

  // --- POUR LES AUTRES (EMPLOYÉ SIMPLE) : GÉNÉRATION JWT DIRECTE ---
  const token = jwt.sign({ id: user.id, emp_id: emp.id, role: userRole, permissions: {} }, process.env.JWT_SECRET, { expiresIn: "8h" });

  return res.json({
    status: "success",
    token: token,
    id: emp.id,
    nom: user.nom_complet,
    role: userRole,
    employee_type: emp.employee_type || "OFFICE"
  });
});

// 2. ROUTE DE VÉRIFICATION DU CODE 2FA
router.post("/verify-2fa", async (req, res) => {
  let { u, code } = req.body;
  
  const email = String(u).toLowerCase().trim();
  const codeSaisi = String(code).trim(); // On force en texte

  console.log(`🔐 Tentative 2FA pour : ${email} avec le code : ${codeSaisi}`);

  // 1. On cherche l'utilisateur par son email uniquement d'abord
  const { data: user, error } = await supabase
    .from("app_users")
    .select("id, email, reset_code, reset_expires, nom_complet, employees(id, role, photo_url, employee_type)")
    .eq("email", email)
    .single();

  if (error || !user) {
    console.error("❌ Utilisateur non trouvé lors du 2FA");
    return res.status(401).json({ status: "error", message: "Session invalide" });
  }

  // 2. VERIFICATION MANUELLE DU CODE (Plus fiable que .eq dans la requête)
  const codeEnBase = String(user.reset_code).trim();
  const expiration = new Date(user.reset_expires);
  const maintenant = new Date();

  if (codeSaisi !== codeEnBase) {
    console.error(`❌ Code incorrect. Saisi: ${codeSaisi}, En base: ${codeEnBase}`);
    return res.status(401).json({ status: "error", message: "Le code est incorrect" });
  }

  if (maintenant > expiration) {
    console.error("❌ Code expiré");
    return res.status(401).json({ status: "error", message: "Le code a expiré (10 min max)" });
  }

  // 3. TOUT EST OK -> RÉCUPÉRATION DES PERMISSIONS
  const emp = user.employees[0];
  const userRole = emp.role.toUpperCase();
  const { data: perms } = await supabase.from("role_permissions").select("*").eq("role_name", userRole).single();

  // 4. NETTOYAGE DU CODE (Usage unique)
  await supabase.from("app_users").update({ reset_code: null, reset_expires: null }).eq("id", user.id);

  // 5. GÉNÉRATION DU TOKEN FINAL
  const token = jwt.sign({
    id: user.id,
    emp_id: emp.id,
    role: userRole,
    permissions: perms || {}
  }, process.env.JWT_SECRET, { expiresIn: "12h" });

  console.log(`✅ 2FA réussi pour ${user.nom_complet}`);

  return res.json({
    status: "success",
    token: token,
    id: emp.id,
    nom: user.nom_complet,
    role: userRole,
    employee_type: emp.employee_type,
    permissions: perms || {}
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
<div style="font-family: sans-serif; color: #1e293b; max-width: 500px; margin: auto; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden;">
    <div style="background-color: #0f172a; padding: 20px; text-align: center;">
        <img src="https://cdn-icons-png.flaticon.com/512/9752/9752284.png" style="width: 50px; height: 50px;">
        <p style="color: #ffffff; margin: 5px 0 0 0; font-size: 14px; font-weight: bold; letter-spacing: 1px;">SÉCURITÉ SIRH</p>
    </div>
    <div style="padding: 30px; text-align: center;">
        <h2 style="margin-top: 0;">Code de vérification</h2>
        <p>Bonjour <b>${user.nom_complet}</b>,</p>
        <p>Vous avez demandé la réinitialisation de votre mot de passe. Voici votre code sécurisé :</p>
        
        <div style="background: #f1f5f9; padding: 20px; margin: 25px 0; font-size: 32px; font-weight: 900; letter-spacing: 10px; color: #2563eb; border-radius: 12px; border: 2px dashed #cbd5e1;">
            ${code}
        </div>
        
        <p style="font-size: 12px; color: #94a3b8;">Ce code expirera dans 15 minutes.<br>Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>
    </div>
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
