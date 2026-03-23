const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const supabase = require("../supabaseClient");
const { sendEmailAPI } = require("../utils");
const JWT_SECRET = process.env.JWT_SECRET;

// 1. LOGIN AVEC 2FA CONDITIONNEL
router.all("/login", async (req, res) => {
  const username = req.body.u || req.query.u;
  const password = req.body.p || req.query.p;

  const { data: user, error } = await supabase
    .from("app_users")
    .select("id, email, password, nom_complet, employees(id, role, photo_url, statut, employee_type, hierarchy_path, management_scope)")
    .eq("email", username)
    .single();

  if (error || !user || user.password !== password) {
    return res.json({ status: "error", message: "Identifiant ou mot de passe incorrect" });
  }

  const emp = user.employees && user.employees.length > 0 ? user.employees[0] : null;
  
  // Kill Switch : Blocage immédiat si l'employé est "Sortie"
  if (emp && (emp.statut || "").toLowerCase().includes("sortie")) {
    return res.json({ status: "revoked", message: "Accès révoqué - Contactez la direction." });
  }

  const userRole = emp ? (emp.role || "EMPLOYEE").toUpperCase().trim() : "EMPLOYEE";

  // ============================================================
  // 🔥 ÉTAPE 2FA : SI ADMIN OU RH, ON ENVOIE UN CODE
  // ============================================================
  if (userRole === "ADMIN" || userRole === "RH") {
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 5 * 60000).toISOString(); // Expire dans 5 min

    // On stocke le code temporairement dans la table app_users
    await supabase.from("app_users").update({ 
        reset_code: otpCode, 
        reset_expires: expires 
    }).eq("id", user.id);

    // Envoi de l'email Premium
    const emailHtml = `
    <div style="font-family: sans-serif; color: #1e293b; max-width: 500px; margin: auto; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden;">
        <div style="background-color: #0f172a; padding: 25px; text-align: center;">
            <img src="https://cdn-icons-png.flaticon.com/512/9752/9752284.png" style="width: 50px;">
            <h1 style="color: #ffffff; margin: 10px 0 0 0; font-size: 18px; text-transform: uppercase;">Sécurité SIRH</h1>
        </div>
        <div style="padding: 30px; text-align: center;">
            <h2 style="color: #0f172a;">Vérification de connexion</h2>
            <p>Bonjour <b>${user.nom_complet}</b>,</p>
            <p>Un accès à haut privilège (<b>${userRole}</b>) a été détecté. Pour continuer, saisissez le code suivant dans l'application :</p>
            
            <div style="background: #f1f5f9; padding: 20px; margin: 25px 0; font-size: 32px; font-weight: 900; letter-spacing: 10px; color: #2563eb; border-radius: 12px; border: 2px dashed #cbd5e1;">
                ${otpCode}
            </div>
            
            <p style="font-size: 12px; color: #94a3b8;">Ce code est à usage unique et expirera dans 5 minutes.</p>
        </div>
    </div>`;

    await sendEmailAPI(user.email, "🔑 Code de sécurité SIRH", emailHtml);

    return res.json({ 
        status: "require_2fa", 
        email: user.email,
        message: "Un code de vérification a été envoyé sur votre boîte mail." 
    });
  }

  // ============================================================
  // CONNEXION NORMALE POUR LES AUTRES RÔLES
  // ============================================================
  const { data: perms } = await supabase.from("role_permissions").select("*").eq("role_name", userRole).single();

  const token = jwt.sign({
      id: user.id, emp_id: emp ? emp.id : null, role: userRole,
      permissions: perms || {}, hierarchy_path: emp ? emp.hierarchy_path : null,
      management_scope: emp ? emp.management_scope : [],
  }, JWT_SECRET, { expiresIn: "8h" });

  return res.json({
    status: "success", token, id: emp ? emp.id : null, nom: user.nom_complet,
    role: userRole, photo: emp ? emp.photo_url : null,
    employee_type: emp ? emp.employee_type : "OFFICE",
    permissions: perms || {}
  });
});


// 2. ROUTE DE VÉRIFICATION DU CODE 2FA
router.all("/verify-2fa", async (req, res) => {
    const { u, code } = req.body;

    // 1. Vérification du code en base
    const { data: user, error } = await supabase
        .from("app_users")
        .select("*, employees(id, role, photo_url, statut, employee_type, hierarchy_path, management_scope)")
        .eq("email", u)
        .eq("reset_code", code)
        .gt("reset_expires", new Date().toISOString())
        .single();

    if (error || !user) {
        return res.status(400).json({ status: "error", message: "Code invalide ou expiré." });
    }

    // 2. Code bon ! On génère le Token final
    const emp = user.employees[0];
    const userRole = emp.role.toUpperCase();
    const { data: perms } = await supabase.from("role_permissions").select("*").eq("role_name", userRole).single();

    // Reset du code en base pour qu'il ne serve plus
    await supabase.from("app_users").update({ reset_code: null, reset_expires: null }).eq("id", user.id);

    const token = jwt.sign({
        id: user.id, emp_id: emp.id, role: userRole,
        permissions: perms || {}, hierarchy_path: emp.hierarchy_path,
        management_scope: emp.management_scope,
    }, JWT_SECRET, { expiresIn: "8h" });

    return res.json({
        status: "success", token, id: emp.id, nom: user.nom_complet,
        role: userRole, photo: emp.photo_url,
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
