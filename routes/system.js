const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const { checkPerm, sendEmailAPI, calculateAutoClose } = require("../utils");

// --- LECTURE DES LOGS ---
router.all("/read-logs", async (req, res) => {
  if (!checkPerm(req, "can_see_audit")) {
    return res.status(403).json({ error: "Accès refusé à l'Audit" });
  }

  const page = parseInt(req.query.page) || 1;
  const limit = 20; // On affiche 20 logs par page
  const offset = (page - 1) * limit;

  try {
    const { data, error, count } = await supabase
      .from("logs")
      .select("*", { count: "exact" }) // Demande le nombre total pour la pagination
      .order("created_at", { ascending: false }) // Les plus récents en premier
      .range(offset, offset + limit - 1); // La clé de la pagination

    if (error) throw error;

    return res.json({
      data: data,
      meta: {
        total: count,
        page: page,
        last_page: Math.ceil(count / limit),
      },
    });
  } catch (err) {
    console.error("Erreur read-logs:", err.message);
    return res.status(500).json({ error: err.message });
  }
});





router.all("/read-report", async (req, res) => {
            const isGlobalMode = req.query.mode === 'GLOBAL';
            const isPersonalMode = req.query.mode === 'PERSONAL';
            const { period } = req.query;
            const now = new Date();
            const todayStr = now.toISOString().split('T')[0];

            try {
                // 1. RÉCUPÉRER TOUS LES EMPLOYÉS ACTIFS (Pour ne pas avoir de trous dans la liste)
                let empQuery = supabase.from('employees')
                    .select('id, nom, matricule, departement, hierarchy_path, statut, employee_type')
                    .not('statut', 'ilike', '%sortie%');

                // Filtres de sécurité (Manager/Perso)
                if (isPersonalMode) empQuery = empQuery.eq('id', req.user.emp_id);
                else if (isGlobalMode && !checkPerm(req, 'can_see_employees')) {
                    const { data: requester } = await supabase.from('employees').select('hierarchy_path, management_scope').eq('id', req.user.emp_id).single();
                    if (requester) {
                        let securityCond = [`hierarchy_path.eq.${requester.hierarchy_path}`, `hierarchy_path.ilike.${requester.hierarchy_path}/%`];
                        if (requester.management_scope?.length > 0) {
                            const scopeList = `(${requester.management_scope.map(s => `"${s}"`).join(',')})`;
                            securityCond.push(`departement.in.${scopeList}`);
                        }
                        empQuery = empQuery.or(securityCond.join(','));
                    }
                }
                const { data: employeesList } = await empQuery;

                // 2. RÉCUPÉRER LES POINTAGES
                let ptgQuery = supabase.from('pointages').select('*');
                if (period === 'today') {
                    ptgQuery = ptgQuery.gte('heure', `${todayStr}T00:00:00`).lte('heure', `${todayStr}T23:59:59`);
                } else {
                    ptgQuery = ptgQuery.gte('heure', new Date(now.getFullYear(), now.getMonth(), 1).toISOString());
                }
                const { data: pointages } = await ptgQuery.order('heure', { ascending: true });

                // 3. LOGIQUE JOURNALIÈRE (LIVE)
                if (period === 'today') {
                    const report = employeesList.map(emp => {
                        const sesPointages = (pointages || []).filter(p => p.employee_id === emp.id);
                        const lastPoint = sesPointages[sesPointages.length - 1];
                        
                        let statut = "ABSENT";
                        let arrivee = "--:--";
                        let dureeStr = "0h 00m";
                        let zone = "---";

                        const firstIn = sesPointages.find(p => p.action === 'CLOCK_IN');
                        if (firstIn) {
                            arrivee = new Date(firstIn.heure).toLocaleTimeString('fr-FR', {hour: '2-digit', minute:'2-digit'});
                            zone = firstIn.zone_detectee || "Terrain";
                            
                            // Calcul durée : Si dernier geste est IN -> calcule jusqu'à NOW. Si OUT -> calcule durée totale.
                            const start = new Date(firstIn.heure).getTime();
                            const end = (lastPoint.action === 'CLOCK_IN') ? now.getTime() : new Date(lastPoint.heure).getTime();
                            const diffMins = Math.max(0, Math.floor((end - start) / 60000));
                            dureeStr = `${Math.floor(diffMins / 60)}h ${(diffMins % 60).toString().padStart(2, '0')}m`;
                            statut = (lastPoint.action === 'CLOCK_IN') ? "PRÉSENT" : "PARTI";
                        }
                        if (statut === "ABSENT" && emp.statut.toLowerCase().includes('cong')) statut = "CONGÉ";

                        return { nom: emp.nom, matricule: emp.matricule, statut, arrivee, duree: dureeStr, zone };
                    });
                    return res.json(report.sort((a,b) => a.statut === "PRÉSENT" ? -1 : 1));
                }

                // 4. LOGIQUE MENSUELLE (RECONSTRUCTION + LIVE)
                else {
                    const report = employeesList.map(emp => {
                        const sesPointages = (pointages || []).filter(p => p.employee_id === emp.id);
                        const isSecurity = (emp.employee_type === 'FIXED' || emp.employee_type === 'SECURITY');
                        
                        let totalMs = 0;
                        let joursSet = new Set();
                        let pendingIn = null;

                        sesPointages.forEach(p => {
                            const time = new Date(p.heure).getTime();
                            joursSet.add(new Date(p.heure).toLocaleDateString());

                            if (p.action === 'CLOCK_IN') {
                                if (pendingIn) totalMs += (calculateAutoClose(pendingIn, isSecurity) - pendingIn);
                                pendingIn = time;
                            } else {
                                if (pendingIn) {
                                    totalMs += (time - pendingIn);
                                    pendingIn = null;
                                }
                            }
                        });

                        // Gestion de la session en cours (Aujourd'hui) ou oubli final
                        if (pendingIn) {
                            if (new Date(pendingIn).toLocaleDateString() === now.toLocaleDateString()) {
                                totalMs += (now.getTime() - pendingIn); // Ajout live
                            } else {
                                totalMs += (calculateAutoClose(pendingIn, isSecurity) - pendingIn);
                            }
                        }

                        const tMins = Math.floor(totalMs / 60000);
                        return {
                            mois: now.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }),
                            nom: emp.nom,
                            jours: joursSet.size,
                            heures: `${Math.floor(tMins / 60)}h ${(tMins % 60).toString().padStart(2, '0')}m`
                        };
                    });
                    return res.json(report);
                }
            } catch (err) { return res.status(500).json({ error: err.message }); }
        });


           
// --- GÉNÉRATION DU BADGE HTML ---
router.all("/badge", async (req, res) => {
  const { id } = req.query;
  if (!req.user) return res.status(401).send("Non connecté");

  const isMe = String(req.user.emp_id) === String(id);
  const canSeeOthers =
    req.user.permissions && req.user.permissions.can_see_employees;

  if (!isMe && !canSeeOthers) {
    return res.status(403).send("Accès refusé.");
  }

  const { data: emp, error } = await supabase
    .from("employees")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !emp) return res.status(404).send("Employé non trouvé.");

  // Préparation des variables calculées pour le CSS et les initiales
  const initials = emp.nom ? emp.nom.substring(0, 2).toUpperCase() : "??";
  const statusClass =
    (emp.statut || "").toLowerCase() === "actif" ? "status-actif" : "";

  // Template HTML Original de Make
  const htmlBadge = `<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <title>Access Card - ${emp.nom}</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;600;800&display=swap');
        
        body {
            margin: 0; padding: 0;
            background-color: #f3f4f6;
            font-family: 'Inter', sans-serif;
            display: flex; justify-content: center; align-items: center;
            height: 100vh;
            -webkit-print-color-adjust: exact;
        }

        .card-container {
            width: 320px; 
            min-height: 580px;
            background: white;
            border-radius: 24px;
            overflow: hidden;
            box-shadow: 0 20px 40px rgba(0,0,0,0.15);
            position: relative;
            border: 1px solid #e2e8f0;
            text-align: center;
            display: flex;
            flex-direction: column;
        }

        .header-bg {
            height: 140px;
            background: linear-gradient(135deg, #1e293b 0%, #3b82f6 100%);
            position: relative;
            flex-shrink: 0;
        }
        
        .company-name {
            color: white; font-weight: 800; letter-spacing: 2px; padding-top: 20px;
            font-size: 14px; opacity: 0.9; text-transform: uppercase;
        }

        .avatar-container {
            width: 130px; height: 130px; background: white; border-radius: 50%; padding: 5px;
            margin: -65px auto 15px auto; position: relative;
            box-shadow: 0 4px 10px rgba(0,0,0,0.1);
            display: flex; align-items: center; justify-content: center;
            overflow: hidden;
            flex-shrink: 0;
            z-index: 10;
        }
        
        .avatar { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; background-color: #f1f5f9; }

        .initials-box {
            width: 100%; height: 100%; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            background: #1e293b; color: white; font-size: 45px; font-weight: 800;
        }

        .name { font-size: 20px; font-weight: 800; color: #1e293b; margin: 0 20px; line-height: 1.2; text-transform: uppercase; }
        .role { color: #3b82f6; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin-top: 5px; margin-bottom: 8px; }
        
        .status-badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 10px;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 15px;
            background: #f1f5f9;
            color: #64748b;
            border: 1px solid #e2e8f0;
        }

        .status-actif {
            background: #dcfce7;
            color: #15803d;
            border: 1px solid #bbf7d0;
        }

        .divider { height: 2px; width: 40px; background: #e2e8f0; margin: 0 auto 15px auto; }

        .qr-box {
            background: #f8fafc; border: 1px dashed #cbd5e1;
            display: inline-block; padding: 8px; border-radius: 12px;
            margin-bottom: 10px;
        }
        
        .qr-img { width: 110px; height: 110px; display: block; }

        .footer-info { 
            margin-top: auto; 
            padding-bottom: 20px; 
            font-size: 10px; 
            color: #94a3b8; 
        }
        
        .id-pill {
            background: #1e293b; color: white; padding: 4px 12px; border-radius: 6px;
            font-size: 12px; font-weight: bold; display: inline-block; margin-top: 5px; font-family: monospace;
        }
    </style>
</head>
<body>

    <div class="card-container">
        <div class="header-bg"><div class="company-name">SIRH-SECURE</div></div>

        <div class="avatar-container">
            <img id="user-photo" src="" class="avatar" style="display:none;">
            <div id="user-initials" class="initials-box">
                ${initials}
            </div>
        </div>

        <div class="name">${emp.nom}</div>
        <div class="role">${emp.poste || ""}</div>
        
        <div>
            <span class="status-badge ${statusClass}">
                ● ${emp.statut || "Actif"}
            </span>
        </div>

        <div class="divider"></div>

        <div>
            <div class="qr-box">
            <img class="qr-img" src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=https://sirh-secure-backend.onrender.com/api/gatekeeper?id=${emp.id}">            </div>
        </div>

        <div class="footer-info">
            MATRICULE OFFICIEL<br>
            <div class="id-pill">${emp.matricule}</div>
        </div>
    </div>

    <script>
        (function() {
            const rawUrl = "${emp.photo_url || ""}";
            const img = document.getElementById('user-photo');
            const initials = document.getElementById('user-initials');
            let finalUrl = "";

            if (rawUrl && rawUrl.includes("drive.google.com")) {
                const parts = rawUrl.split(/\\/(?:d|open|file\\/d|id=)\\/([a-zA-Z0-9_-]+)/);
                const fileId = parts[1] || rawUrl.split("id=")[1];
                if (fileId) {
                    finalUrl = "https://lh3.googleusercontent.com/d/" + fileId.split('&')[0];
                }
            } else if (rawUrl && rawUrl.startsWith("http")) {
                finalUrl = rawUrl;
            }

            if (finalUrl) {
                img.src = finalUrl;
                img.onload = function() {
                    img.style.display = "block";
                    initials.style.display = "none";
                    setTimeout(() => { window.print(); }, 800);
                };
                img.onerror = function() {
                    img.style.display = "none";
                    initials.style.display = "flex";
                    setTimeout(() => { window.print(); }, 800);
                };
            } else {
                setTimeout(() => { window.print(); }, 800);
            }
        })();
    </script>

</body>
</html>`;

  return res.send(htmlBadge);
});

//--//

router.all("/gatekeeper", async (req, res) => {
  const { id, key } = req.query;
  const SCAN_KEY = "SIGD_SECURE_2025";

  // 1. Récupérer l'employé
  const { data: emp, error } = await supabase
    .from("employees")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !emp) return res.status(404).send("Badge invalide ou inconnu.");

  const isSortie = (emp.statut || "").toLowerCase().includes("sortie");

  // --------------------------------------------------------
  // CAS A : SCAN DEPUIS L'APP (TERMINAL SÉCURISÉ)
  // --------------------------------------------------------
  if (key === SCAN_KEY) {
    if (isSortie) {
      console.log(`🚫 Accès Refusé (Statut Sortie) : ${emp.nom}`);
      return res.json({
        status: "REFUSÉ",
        nom: `MATRICULE:${emp.id}----NOM:${emp.nom}----STATUT: ACCÈS REFUSÉ (DÉPART DÉFINITIF)`,
        poste: emp.poste,
      });
    }

    console.log(`📱 Accès Autorisé : ${emp.nom}`);
    return res.json({
      status: "valid",
      nom: `MATRICULE:${emp.id}----NOM:${emp.nom}----POSTE :${emp.poste}----NUMERO:${emp.telephone}----ADRESSE:${emp.adresse}---- STATUT:${emp.statut}----DATE SCANNE:${new Date().toLocaleString()}`,
      poste: emp.poste,
    });
  }

  // --------------------------------------------------------
  // CAS B : SCAN PUBLIC (TÉLÉPHONE EXTERNE)
  // --------------------------------------------------------
  else {
    console.log(`🚨 Scan Public détecté pour : ${emp.nom}`);

    const nowStr = new Date().toLocaleString("fr-FR");

    // --- EMAIL POUR L'ADMIN (LOG DE SÉCURITÉ) ---
    const adminMail = {
      from: `"Sécurité SIRH" <${process.env.SMTP_USER}>`,
      to: "nevillebouchard98@gmail.com",
      subject: `LOG DE SÉCURITÉ - CONSULTATION DE PROFIL - ${emp.nom}`,
      text: `LOG DE SÉCURITÉ - CONSULTATION DE PROFIL

Bonjour,

Le profil numérique lié au badge suivant vient d'être consulté via un terminal mobile (hors réseau de pointage officiel)

Détails du badge consulté :
👤 Employé : ${emp.nom}
🆔 ID : ${emp.matricule}
💼 Poste : ${emp.poste}
📍 Site : Zogbo

Détails de l'accès :
📅 Date/Heure : ${nowStr}
🌐 Méthode : Scan QR Code (Portail Public)

Action recommandée :
Veuillez contacter l'employé pour confirmer la restitution du badge et vérifier si une désactivation temporaire des accès est nécessaire.

Ce message est envoyé pour assurer la traçabilité des consultations d'identité en dehors des terminaux de l'entreprise.`,
    };

    // --- EMAIL POUR L'EMPLOYÉ ---
    const employeeMail = {
      from: `"Service Sécurité - SIRH SECURE" <${process.env.SMTP_USER}>`,
      to: emp.email,
      subject: `Votre badge professionnel a été scanné`,
      text: `SERVICE SÉCURITÉ - SIRH SECURE

Bonjour ${emp.nom},

Nous vous informons que votre badge professionnel (ID: ${emp.id}) a été scanné et signalé comme "Retrouvé" par une tierce personne le ${nowStr}.

Si vous avez toujours votre badge en votre possession :
Il s'agit probablement d'un test ou d'une erreur. Vous n'avez rien à faire.

Si vous avez perdu votre badge :
Restez joignable sur votre numéro (${emp.telephone}).
Une personne de la sécurité ou des RH va vous contacter sous peu.

Présentez-vous à l'accueil de l'agence Zogbo dès que possible.

Ceci est un message pour la protection de vos accès, un message est aussi envoyé aux administrateurs.`,
    };

    try {
      await sendEmailAPI(
        "nevillebouchard98@gmail.com",
        adminMail.subject,
        adminMail.text,
      );
      await sendEmailAPI(emp.email, employeeMail.subject, employeeMail.text);
    } catch (e) {
      console.error("Erreur mails sécurité:", e.message);
    }

    // Log d'audit
    await supabase.from("logs").insert([
      {
        agent: "PORTAIL_PUBLIC",
        action: "SCAN_EXTERNE",
        details: `Badge ${emp.nom} scanné par un tiers.`,
      },
    ]);

    // Page HTML de retour (Ton template de validation)
    return res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Validation de Badge - ${emp.nom}</title>
    <style>
        :root { --brand-color: #2563eb; --bg-light: #f1f5f9; --text-main: #1e293b; --text-muted: #64748b; }
        body { font-family: sans-serif; background-color: var(--bg-light); margin: 0; padding: 20px; color: var(--text-main); display: flex; justify-content: center; }
        .card { max-width: 420px; width: 100%; background: white; border-radius: 24px; box-shadow: 0 15px 35px rgba(0,0,0,0.1); overflow: hidden; border: 1px solid #e2e8f0; }
        .company-header { background: var(--brand-color); color: white; padding: 20px; text-align: center; font-weight: 800; text-transform: uppercase; }
        .profile-area { text-align: center; padding: 30px 20px 20px; }
        .avatar { width: 130px; height: 130px; background: #f8fafc; border-radius: 50%; margin: 0 auto 15px; border: 4px solid white; box-shadow: 0 4px 10px rgba(0,0,0,0.1); overflow: hidden; }
        .avatar img { width: 100%; height: 100%; object-fit: cover; }
        .name { font-size: 22px; font-weight: 700; margin: 0; }
        .info-section { background: #f8fafc; margin: 0 25px 25px; padding: 20px; border-radius: 16px; }
        .info-row { display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 14px; }
        .lost-found { padding: 20px 25px; border-top: 1px solid #f1f5f9; text-align: center; }
        .btn { display: block; width: 100%; padding: 14px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 14px; margin-bottom: 10px; border: none; }
        .btn-call { background: var(--brand-color); color: white; }
        .btn-report { background: #fff1f2; color: #be123c; border: 1px solid #fecdd3; }
    </style>
</head>
<body>
<div class="card">
    <div class="company-header">SIRH- SECURE</div>
    <div class="profile-area">
        <div class="avatar"><img src="${emp.photo_url || "https://ui-avatars.com/api/?name=" + emp.nom}" alt="Photo"></div>
        <h1 class="name">${emp.nom}</h1>
        <div style="color:var(--brand-color); font-weight:600;">${emp.poste}</div>
    </div>
    <div class="info-section">
        <div class="info-row"><span>ID Employé :</span><strong>${emp.id}</strong></div>
        <div class="info-row"><span>Département :</span><strong>${emp.departement}</strong></div>
        <div class="info-row"><span>Statut :</span><strong style="color: #059669;">Badge Vérifié ✓</strong></div>
    </div>
    <div class="lost-found">
        <p><strong>Vous avez trouvé ce badge ?</strong><br>Merci de nous contacter pour le restituer.</p>
        <a href="tel:+2290154978999" class="btn btn-call">📞 Appeler l'entreprise</a>
        <button class="btn btn-report" onclick="alert('Signalement transmis aux administrateurs.')">⚠️ Signaler comme PERDU</button>
    </div>
</div>
</body>
</html>`);
  }
});



// ============================================================
// 10. GÉNÉRATEUR DE RAPPORTS (RECALCUL INTELLIGENT & AUTO-CLOSE)
// ============================================================
 const isGlobalMode = req.query.mode === 'GLOBAL';
            const isPersonalMode = req.query.mode === 'PERSONAL';
            const { period } = req.query;
            const now = new Date();
            const todayStr = now.toISOString().split('T')[0];

            if (isGlobalMode && !checkPerm(req, 'can_see_dashboard')) {
                return res.status(403).json({ error: "Accès refusé" });
            }

            try {
                // 1. RÉCUPÉRATION DES DONNÉES DE BASE
                let query = supabase
                    .from('pointages')
                    .select('*, employees!inner(nom, matricule, hierarchy_path, departement, employee_type)');

                // Filtre Sécurité (Qui a le droit de voir quoi)
                if (isPersonalMode) {
                    query = query.eq('employee_id', req.user.emp_id);
                } 
                else if (isGlobalMode && !checkPerm(req, 'can_see_employees')) {
                    const { data: reqData } = await supabase.from('employees').select('hierarchy_path, management_scope').eq('id', req.user.emp_id).single();
                    if (reqData) {
                        let filterCond = [`employees.hierarchy_path.ilike.${reqData.hierarchy_path}/%`];
                        if (reqData.management_scope?.length > 0) {
                            const scopeList = `(${reqData.management_scope.map(s => `"${s}"`).join(',')})`;
                            filterCond.push(`employees.departement.in.${scopeList}`);
                        }
                        query = query.or(filterCond.join(','));
                    }
                }

                // Filtre de Période
                if (period === 'today') {
                    query = query.gte('heure', `${todayStr}T00:00:00`).lte('heure', `${todayStr}T23:59:59`);
                } else {
                    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
                    query = query.gte('heure', startOfMonth);
                }

                // Important : On trie par heure pour reconstruire la timeline
                const { data: pointages, error } = await query.order('heure', { ascending: true });
                if (error) throw error;

                // --- TRAITEMENT DU MODE AUJOURD'HUI (PRÉSENCES LIVE) ---
                if (period === 'today') {
                    const latestByEmp = {};
                    (pointages || []).forEach(p => {
                        latestByEmp[p.employee_id] = p; // On garde le dernier état
                    });

                    const report = Object.values(latestByEmp).map(p => {
                        const isCurrentlyIn = (p.action === 'CLOCK_IN');
                        let dureeDisplay = "0h 00m";
                        
                        if (isCurrentlyIn) {
                            const diffMins = Math.floor((now - new Date(p.heure)) / 60000);
                            dureeDisplay = `${Math.floor(diffMins / 60)}h ${(diffMins % 60).toString().padStart(2, '0')}m`;
                        }

                        return {
                            nom: p.employees.nom,
                            matricule: p.employees.matricule,
                            statut: isCurrentlyIn ? "PRÉSENT" : "PARTI",
                            arrivee: new Date(p.heure).toLocaleTimeString('fr-FR', {hour: '2-digit', minute:'2-digit'}),
                            zone: p.zone_detectee || "Terrain",
                            duree: dureeDisplay
                        };
                    });
                    return res.json(report);
                } 
                
                // --- TRAITEMENT DU MODE MENSUEL (CUMUL INTELLIGENT) ---
                else {
                    const monthlyStats = {};
                    const pointsByEmp = {};

                    // Groupement initial
                    pointages.forEach(p => {
                        if (!pointsByEmp[p.employee_id]) pointsByEmp[p.employee_id] = [];
                        pointsByEmp[p.employee_id].push(p);
                    });

                    for (const empId in pointsByEmp) {
                        const events = pointsByEmp[empId];
                        const empInfo = events[0].employees;
                        const isSecurity = (empInfo.employee_type === 'FIXED' || empInfo.employee_type === 'SECURITY');
                        
                        if (!monthlyStats[empId]) {
                            monthlyStats[empId] = { nom: empInfo.nom, totalMs: 0, joursPresence: new Set() };
                        }

                        let pendingInTime = null;

                        events.forEach(ev => {
                            const evTime = new Date(ev.heure).getTime();
                            const evDateStr = new Date(ev.heure).toLocaleDateString();

                            if (ev.action === 'CLOCK_IN') {
                                // S'il y avait déjà un IN sans OUT (Oubli du pointage précédent)
                                if (pendingInTime !== null) {
                                    monthlyStats[empId].totalMs += (calculateAutoClose(pendingInTime, isSecurity) - pendingInTime);
                                }
                                pendingInTime = evTime;
                                monthlyStats[empId].joursPresence.add(evDateStr);
                            } 
                            else if (ev.action === 'CLOCK_OUT') {
                                if (pendingInTime !== null) {
                                    // Match parfait IN -> OUT
                                    monthlyStats[empId].totalMs += (evTime - pendingInTime);
                                    pendingInTime = null;
                                }
                            }
                        });

                        // --- GESTION DE LA FIN DE TIMELINE (Le pointage actuel) ---
                        if (pendingInTime !== null) {
                            const lastInDate = new Date(pendingInTime).toLocaleDateString();
                            const isStillToday = (lastInDate === now.toLocaleDateString());

                            if (isStillToday) {
                                // 🟢 CALCUL LIVE : Il est au travail en ce moment
                                monthlyStats[empId].totalMs += (now.getTime() - pendingInTime);
                            } else {
                                // 🔴 OUBLI PASSÉ : On ferme selon la règle
                                monthlyStats[empId].totalMs += (calculateAutoClose(pendingInTime, isSecurity) - pendingInTime);
                            }
                        }
                    }

                    // Formatage final pour le tableau
                    const finalReport = Object.values(monthlyStats).map(s => {
                        const totalMins = Math.floor(s.totalMs / 60000);
                        const hh = Math.floor(totalMins / 60);
                        const mm = totalMins % 60;
                        return {
                            mois: now.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }),
                            nom: s.nom,
                            jours: s.joursPresence.size,
                            heures: `${hh}h ${mm.toString().padStart(2, '0')}m`,
                            statut: "Validé"
                        };
                    });

                    return res.json(finalReport);
                }
            } catch (err) {
                console.error("Erreur Moteur Rapport:", err.message);
                return res.status(500).json({ error: err.message });
            }
        }






// --- FLASH MESSAGES ---
router.all("/read-flash", async (req, res) => {
  const now = new Date().toISOString();

  // On récupère uniquement les messages non expirés
  const { data, error } = await supabase
    .from("flash_messages")
    .select("id, message, sender, type, created_at")
    .gt("date_expiration", now)
    .order("created_at", { ascending: false });

  if (error) throw error;

  // On mappe pour que le Frontend reçoive les noms attendus
  const mapped = data.map((m) => ({
    Message: m.message,
    Sender: m.sender,
    Type: m.type,
    Date: m.created_at,
    id: m.id,
  }));

  return res.json(mapped);
});

router.all("/write-flash", async (req, res) => {
  if (!req.user.permissions || !req.user.permissions.can_send_announcements) {
    return res
      .status(403)
      .json({ error: "Accès refusé à la diffusion d'annonces" });
  }

  const { message, type, sender, date_expiration } = req.body;

  const { error } = await supabase.from("flash_messages").insert([
    {
      message,
      type,
      sender,
      date_expiration,
    },
  ]);

  if (error) throw error;

  console.log(
    `📢 Nouvelle annonce de ${sender} : ${message.substring(0, 30)}...`,
  );
  return res.json({ status: "success" });
});

// --- MAINTENANCE ARCHIVES ---
// --- MAINTENANCE ARCHIVES ---
router.all("/run-archiving-job", async (req, res) => {
  if (!checkPerm(req, "can_manage_config"))
    return res.status(403).json({ error: "Droits requis." });

  // On initialise les compteurs à 0
  const results = { logs_archived: 0, photos_deleted: 0, employees: 0 };

  try {
    // 1. PURGE DES PHOTOS DE VISITE (> 2 ANS)
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

    const { data: toDelete } = await supabase
      .from("visit_reports")
      .select("id, proof_url")
      .lt("check_in_time", twoYearsAgo.toISOString())
      .not("proof_url", "is", null);

    if (toDelete && toDelete.length > 0) {
      const filePaths = toDelete
        .map((v) => v.proof_url.split("/documents/")[1])
        .filter((p) => p);

      // Suppression physique sur le Storage
      const { error: storageErr } = await supabase.storage
        .from("documents")
        .remove(filePaths);

      if (!storageErr) {
        const ids = toDelete.map((v) => v.id);
        await supabase
          .from("visit_reports")
          .update({ proof_url: null })
          .in("id", ids);
        results.photos_deleted = filePaths.length;
      }
    }

    // 2. ARCHIVAGE DES LOGS (> 1 AN)
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const { data: oldLogs } = await supabase
      .from("logs")
      .select("*")
      .lt("created_at", oneYearAgo.toISOString());

    if (oldLogs && oldLogs.length > 0) {
      const { error: arcErr } = await supabase
        .from("logs", { schema: "archives" })
        .insert(oldLogs);
      
      if (!arcErr) {
        await supabase
          .from("logs")
          .delete()
          .lt("created_at", oneYearAgo.toISOString());
        results.logs_archived = oldLogs.length;
      }
    }

    // ============================================================
    // 3. ARCHIVAGE DES EMPLOYÉS "SORTIE" (NOUVEAU ✅)
    // ============================================================
    // On cherche les employés marqués "Sortie"
    const { data: exitedEmployees } = await supabase
      .from("employees")
      .select("*")
      .ilike("statut", "%Sortie%"); // Recherche insensible à la casse

    if (exitedEmployees && exitedEmployees.length > 0) {
      // A. On tente de les insérer dans la table d'archive
      // ATTENTION : La table "employees" doit exister dans le schéma "archives" de Supabase
      const { error: empArcErr } = await supabase
        .from("employees", { schema: "archives" })
        .insert(exitedEmployees);

      // B. Si la copie a marché, on les supprime de la table principale
      if (!empArcErr) {
        const idsToDelete = exitedEmployees.map(e => e.id);
        
        await supabase
          .from("employees")
          .delete()
          .in("id", idsToDelete);
          
        // On supprime aussi leur accès utilisateur pour être sûr
        const userIds = exitedEmployees.map(e => e.user_associated_id).filter(id => id);
        if (userIds.length > 0) {
            await supabase.from("app_users").delete().in("id", userIds);
        }

        results.employees = exitedEmployees.length; // On met à jour le chiffre
      } else {
        console.warn("Archivage employés impossible (Table manquante ?) :", empArcErr.message);
      }
    }

    return res.json({ status: "success", report: results });

  } catch (err) {
    console.error("Erreur Maintenance:", err);
    return res.status(500).json({ error: err.message });
  }
});

// --- SETTINGS & MODULES ---
router.all("/list-departments", async (req, res) => {
  const { data, error } = await supabase
    .from("departments")
    .select("*")
    .eq("is_active", true)
    .order("label", { ascending: true });

  if (error) throw error;
  return res.json(data);
});

router.all("/list-roles", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("role_permissions")
      .select("role_name")
      .order("role_name", { ascending: true });

    if (error) throw error;
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.all("/read-settings", async (req, res) => {
  const { data, error } = await supabase
    .from("app_settings")
    .select("*")
    .order("label", { ascending: true });

  if (error) {
    console.error("❌ Erreur lecture settings:", error.message);
    throw error;
  }
  return res.json(data);
});

router.all("/read-modules", async (req, res) => {
  // Public pour les utilisateurs connectés (sert à construire le menu)
  const { data } = await supabase.from("company_modules").select("*");
  return res.json(data);
});

router.all("/get-boss-summary", async (req, res) => {
  const { month, year } = req.query;
  const startDate = `${year}-${month}-01`;

  // On récupère les visites de tous les délégués pour le mois
  const { data, error } = await supabase
    .from("visit_reports")
    .select(
      "*, employees(nom, matricule, poste), mobile_locations(name, zone_name)",
    )
    .gte("check_in_time", startDate);

  if (error) throw error;

  // On organise par employé
  const summary = {};
  data.forEach((v) => {
    const e = v.employees;
    if (!summary[e.nom])
      summary[e.nom] = {
        nom: e.nom,
        matricule: e.matricule,
        total: 0,
        details: [],
      };

    summary[e.nom].total++;
    summary[e.nom].details.push({
      lieu: v.mobile_locations.name,
      zone: v.mobile_locations.zone_name,
      date: v.check_in_time,
      resultat: v.outcome,
      notes: v.notes,
    });
  });

  return res.json(Object.values(summary));
});

router.all("/get-dashboard-stats", async (req, res) => {
  if (!checkPerm(req, "can_see_dashboard")) {
    return res.status(403).json({ error: "Accès interdit aux statistiques" });
  }

  try {
    const today = new Date().toISOString().split("T")[0];
    const currentUserId = req.user.emp_id;

    // Calcul de la date d'alerte pour les contrats (Aujourd'hui + 15 jours)
    const dateAlerteArr = new Date();
    dateAlerteArr.setDate(dateAlerteArr.getDate() + 15);
    const alertLimitStr = dateAlerteArr.toISOString().split("T")[0];

    // --- 1. RÉCUPÉRATION DU PÉRIMÈTRE ---
    const { data: requester } = await supabase
      .from("employees")
      .select("hierarchy_path, management_scope")
      .eq("id", currentUserId)
      .single();

    let query = supabase
      .from("employees")
      .select("id, statut, departement, hierarchy_path, date_fin_contrat");

    // --- 2. FILTRE DE SÉCURITÉ ---
    if (!checkPerm(req, "can_see_employees")) {
      if (req.user.role === "MANAGER" && requester) {
        let conditions = [];
        conditions.push(`hierarchy_path.eq.${requester.hierarchy_path}`);
        conditions.push(`hierarchy_path.ilike.${requester.hierarchy_path}/%`);

        if (requester.management_scope?.length > 0) {
          const scopeList = `(${requester.management_scope.map((s) => `"${s}"`).join(",")})`;
          conditions.push(`departement.in.${scopeList}`);
        }
        query = query.or(conditions.join(","));
      } else {
        query = query.eq("id", currentUserId);
      }
    }

    const { data: employeesList, error: errEmp } = await query;
    if (errEmp) throw errEmp;

    // --- 3. GESTION DES CONGÉS ACTIFS ---
    const allowedIds = employeesList.map((e) => e.id);

    const { data: activeLeaves } = await supabase
      .from("conges")
      .select("employee_id")
      .eq("statut", "Validé")
      .lte("date_debut", today)
      .gte("date_fin", today)
      .in("employee_id", allowedIds);

    const idsEnCongePlanifie = new Set(
      (activeLeaves || []).map((l) => l.employee_id),
    );

    // --- 4. NOUVEAU : COMPTEURS GLOBAUX POUR LES SIGNAUX ---

    // A. Compter les congés en attente dans tout le périmètre
    const { count: pendingCount } = await supabase
      .from("conges")
      .select("*", { count: "exact", head: true })
      .in("employee_id", allowedIds)
      .eq("statut", "En attente");

    // B. Compter les contrats finissant dans les 15 jours dans tout le périmètre
    // On filtre manuellement sur la liste déjà récupérée pour économiser une requête
    const contractAlerts = employeesList.filter(
      (e) =>
        e.date_fin_contrat &&
        e.date_fin_contrat >= today &&
        e.date_fin_contrat <= alertLimitStr &&
        !e.statut.toLowerCase().includes("sortie"),
    ).length;

    // --- 5. CALCUL DES STATISTIQUES (Basé sur la liste complète autorisée) ---
    const stats = {
      total: employeesList.length,
      actifs: 0,
      sortis: 0,
      enConge: 0,
      depts: {},
      // Ajout des données pour les signaux
      alertConges: pendingCount || 0,
      alertContrats: contractAlerts || 0,
    };

    employeesList.forEach((emp) => {
      const s = (emp.statut || "Actif").toLowerCase().trim();

      if (s === "sortie") {
        stats.sortis++;
      } else if (s.includes("cong") || idsEnCongePlanifie.has(emp.id)) {
        stats.enConge++;
      } else {
        stats.actifs++;
      }

      const d = emp.departement || "Non défini";
      stats.depts[d] = (stats.depts[d] || 0) + 1;
    });

    return res.json(stats);
  } catch (err) {
    console.error("Erreur stats filtrées:", err.message);
    return res.status(500).json({ error: err.message });
  }
});


// Route pour simuler/vérifier l'heure de clôture (Test)
router.all("/check-closing-time", async (req, res) => {
    // On reçoit l'heure d'entrée et le type (Security ou non)
    const { startTime, isSecurity } = req.body;

    if (!startTime) return res.status(400).json({ error: "Date début manquante" });

    // On utilise ta fonction
    const startMs = new Date(startTime).getTime();
    const closingMs = calculateAutoClose(startMs, isSecurity === true || isSecurity === 'true');
    
    const closingDate = new Date(closingMs);

    return res.json({
        status: "success",
        entree: new Date(startMs).toLocaleString('fr-FR'),
        type: isSecurity ? "Sécurité (12h)" : "Bureau/Mobile (18h)",
        cloture_prevue: closingDate.toLocaleString('fr-FR')
    });
});

module.exports = router;
