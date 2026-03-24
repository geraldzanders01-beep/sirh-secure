const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const supabase = require("../supabaseClient");
const { sendEmailAPI } = require("../utils");
const JWT_SECRET = process.env.JWT_SECRET;

// 1. LOGIN AVEC 2FA CONDITIONNEL
router.all("/login", async (req, res) => {
  try {
    const username = (req.body.u || req.query.u || "").toLowerCase().trim();
    const password = req.body.p || req.query.p;

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
    if (emp && emp.statut && emp.statut.toLowerCase().includes("sortie")) {
      return res.json({ status: "revoked", message: "Accès révoqué. Contactez la direction." });
    }

    // ============================================================
    // 🔥 LOGIQUE 2FA POUR ADMIN & RH
    // ============================================================
    if (userRole === "ADMIN" || userRole === "RH") {
      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
      const expires = new Date(Date.now() + 10 * 60000).toISOString();

      await supabase.from("app_users")
        .update({ reset_code: otpCode, reset_expires: expires })
        .eq("id", user.id);

      const emailHtml = `
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
                  ${otpCode}
              </div>
              <p style="font-size: 12px; color: #94a3b8;">Ce code expirera dans 10 minutes.<br>Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>
          </div>
      </div>`;

      await sendEmailAPI(user.email, "Votre code de sécurité SIRH", emailHtml);
      return res.json({ status: "require_2fa", email: user.email });
    }

    // --- POUR LES AUTRES (EMPLOYÉ SIMPLE) : GÉNÉRATION JWT DIRECTE ---
    const token = jwt.sign({ 
        id: user.id, 
        emp_id: emp ? emp.id : null, 
        role: userRole, 
        permissions: {} 
    }, JWT_SECRET, { expiresIn: "8h" });

    return res.json({
      status: "success",
      token: token,
      id: emp ? emp.id : null,
      nom: user.nom_complet,
      role: userRole,
      employee_type: emp ? emp.employee_type : "OFFICE"
    });
  } catch (err) {
    console.error("Login Crash:", err);
    return res.status(500).json({ error: "Erreur serveur interne" });
  }
});






// 2. ROUTE DE VÉRIFICATION DU CODE 2FA (Version Spéciale Timezone)
router.post("/verify-2fa", async (req, res) => {
  try {
    const email = String(req.body.u || "").toLowerCase().trim();
    const codeSaisi = String(req.body.code || "").trim();

    console.log(`[2FA-START] 🔐 Vérification pour : ${email}`);

    if (!email || !codeSaisi) {
        return res.status(400).json({ status: "error", message: "Données manquantes" });
    }

    // 1. Récupération de l'utilisateur
    const { data: user, error } = await supabase
      .from("app_users")
      .select("id, email, reset_code, reset_expires, nom_complet, employees(id, role, photo_url, employee_type)")
      .eq("email", email)
      .single();

    if (error || !user) {
      return res.status(401).json({ status: "error", message: "Session expirée. Veuillez vous reconnecter." });
    }

    // 2. Comparaison du code (En forçant le format texte)
    const codeEnBase = user.reset_code ? String(user.reset_code).trim() : null;
    
    if (!codeEnBase || codeSaisi !== codeEnBase) {
      console.error(`[2FA-FAIL] ❌ Code incorrect pour ${email}. Saisi: ${codeSaisi} | Base: ${codeEnBase}`);
      return res.status(401).json({ status: "error", message: "Le code de sécurité est incorrect." });
    }

    // 3. VÉRIFICATION TEMPORELLE ABSOLUE (En millisecondes)
    const maintenantMS = Date.now(); // Temps actuel universel
    const expirationMS = new Date(user.reset_expires).getTime(); // Temps d'expiration universel
    
    // On ajoute une marge de 5 minutes (300 000 ms) pour compenser les décalages de serveurs
    const margeErreur = 5 * 60 * 1000; 

    console.log(`[2FA-TIME] Maintenant: ${maintenantMS} | Expire: ${expirationMS} | Diff: ${maintenantMS - expirationMS}ms`);

    if (maintenantMS > (expirationMS + margeErreur)) {
      console.error(`[2FA-FAIL] ⏰ Code expiré pour ${email}`);
      return res.status(401).json({ status: "error", message: "Ce code a expiré. Veuillez recommencer la connexion." });
    }

    // 4. RÉCUPÉRATION DES DROITS
    const emp = Array.isArray(user.employees) ? user.employees[0] : user.employees;
    if (!emp) {
        return res.status(401).json({ status: "error", message: "Profil employé manquant." });
    }

    const userRole = (emp.role || "EMPLOYEE").toUpperCase();
    const { data: perms } = await supabase.from("role_permissions").select("*").eq("role_name", userRole).single();

    // 5. NETTOYAGE DU CODE (Usage unique)
    await supabase.from("app_users").update({ reset_code: null, reset_expires: null }).eq("id", user.id);

    // 6. GÉNÉRATION DU TOKEN JWT FINAL
    const token = jwt.sign({
      id: user.id,
      emp_id: emp.id,
      role: userRole,
      permissions: perms || {}
    }, JWT_SECRET, { expiresIn: "12h" });

    return res.json({
      status: "success",
      token,
      id: emp.id,
      nom: user.nom_complet,
      role: userRole,
      employee_type: emp.employee_type || "OFFICE",
      permissions: perms || {}
    });

  } catch (err) {
    console.error(`[2FA-CRASH] 💥 Erreur:`, err.message);
    return res.status(500).json({ status: "error", message: "Erreur technique serveur." });
  }
});




// A. DEMANDER UN CODE (VERSION SÉCURISÉE)
router.all("/request-password-reset", async (req, res) => {
  const email = req.body.email ? req.body.email.toLowerCase().trim() : "";
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = new Date(Date.now() + 15 * 60000).toISOString();

  const { data: user, error } = await supabase
    .from("app_users")
    .update({ reset_code: code, reset_expires: expires })
    .eq("email", email)
    .select("nom_complet")
    .maybeSingle();

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

  return res.json({ status: "success", message: "Procédure lancée." });
});






// B. VALIDER LE CHANGEMENT
router.all("/reset-password", async (req, res) => {
  const { email, code, newPassword } = req.body;
  const cleanEmail = (email || "").toLowerCase().trim();

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

  await supabase.from("app_users").update({
      password: newPassword,
      reset_code: null,
      reset_expires: null,
    }).eq("id", user.id);

  await supabase.from("logs").insert([{
      agent: "Système",
      action: "SÉCURITÉ",
      details: `Mot de passe réinitialisé pour : ${cleanEmail}`,
    }]);

  return res.json({ status: "success" });
});

module.exports = router;
