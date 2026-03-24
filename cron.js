const cron = require('node-cron');
const supabase = require('./supabaseClient');
const pLimit = require('p-limit');
const limit = pLimit(5);

const startCronJobs = () => {
    // Le CRON tourne TOUTES LES HEURES (minute 0)
    cron.schedule('0 * * * *', async () => {
        console.log("⏰ [CRON] Vérification Intelligente des Shifts en cours...");
        const nowMs = Date.now();

        try {
            // 1. On récupère tous les employés "En Poste"
            const { data: enPoste } = await supabase
                .from('employees')
                .select('id, nom, employee_type')
                .eq('statut', 'En Poste');

            if (!enPoste || enPoste.length === 0) return;

            // 2. On récupère la date de leur ENTRÉE exacte
            const ids = enPoste.map(e => e.id);
            const { data: lastPointages } = await supabase
                .from('pointages')
                .select('employee_id, heure')
                .in('employee_id', ids)
                .eq('action', 'CLOCK_IN')
                .order('heure', { ascending: false });

            const tasks = enPoste.map(emp => limit(async () => {
                const sonPointage = lastPointages.find(p => p.employee_id === emp.id);
                if (!sonPointage) return;

                const inTime = new Date(sonPointage.heure).getTime();
                const shiftDurationHours = (nowMs - inTime) / (1000 * 60 * 60);

                // --- ⚙️ CONFIGURATION DES RÈGLES PAR MÉTIER ---
                let maxDuration = 14;       // Limite max avant clôture auto
                let logicCloseAddHours = 9; // On ramène sa journée à 9h de travail sur sa paie
                let warnDuration = 12;      // Heure du Smart Ping (Alerte)

                if (emp.employee_type === 'FIXED' || emp.employee_type === 'SECURITY') {
                    maxDuration = 17;       // Les gardes peuvent faire 16h sans problème
                    logicCloseAddHours = 12;// Si on le ferme auto, on lui paie 12h max
                    warnDuration = 15;
                }

                // --- 🔔 SOLUTION 4 : LE SMART PING (Alerte avant punition) ---
                if (shiftDurationHours >= warnDuration && shiftDurationHours < maxDuration) {
                    // On lui envoie un Flash Message Urgent ciblé (qui déclenche une notification Push sur son tel)
                    await supabase.from('flash_messages').insert([{
                        message: `⚠️ ALERTE POINTAGE : ${emp.nom}, vous êtes en poste depuis plus de ${Math.floor(shiftDurationHours)} heures. Avez-vous oublié de pointer votre sortie ?`,
                        type: 'Urgent',
                        sender: 'Robot SIRH',
                        date_expiration: new Date(nowMs + (2 * 60 * 60 * 1000)).toISOString() // Expire dans 2h
                    }]);
                    console.log(`🔔 Smart Ping envoyé à ${emp.nom}`);
                }

                // --- 🤖 SOLUTIONS 1, 2 & 3 : AUTO-CLÔTURE INTELLIGENTE ---
                else if (shiftDurationHours >= maxDuration) {
                    
                    // L'IA du système : On ne clôture pas à l'heure du CRON (sinon on paie 14h),
                    // on rétro-clôture à Heure d'Entrée + X heures logiques !
                    const logicalEndTime = new Date(inTime + (logicCloseAddHours * 60 * 60 * 1000));

                    // A. Enregistrement de la sortie rétroactive
                    await supabase.from('pointages').insert([{
                        employee_id: emp.id,
                        action: 'CLOCK_OUT',
                        heure: logicalEndTime.toISOString(), // L'heure corrigée !
                        is_final_out: true,
                        zone_detectee: "AUTO_CLOSURE",
                        statut: "Oubli - Ajusté Auto" // Le RH verra ça
                    }]);

                    // B. Libération de l'agent
                    await supabase.from('employees').update({ statut: 'Actif' }).eq('id', emp.id);
                    
                    // C. Log de sécurité pour le RH
                    await supabase.from('logs').insert([{
                        agent: "Robot SIRH",
                        action: "PROTECTION PAIE",
                        details: `Clôture auto de ${emp.nom} après ${shiftDurationHours.toFixed(1)}h d'oubli. Shift ramené à ${logicCloseAddHours}h.`
                    }]);

                    console.log(`✅ Auto-clôture intelligente appliquée pour : ${emp.nom}`);
                }
            }));

            await Promise.all(tasks);

        } catch (err) { 
            console.error("❌ Erreur critique Cron :", err); 
        }
    });
};


// Tâche quotidienne à 08:00
cron.schedule('0 8 * * *', async () => {
    console.log("🤖 [ROBOT CONTRATS] Scan des échéances en cours...");

    try {
        // 1. Calcul des dates cibles
        const today = new Date();
        const in30Days = new Date(new Date().setDate(today.getDate() + 30)).toISOString().split('T')[0];
        const in7Days = new Date(new Date().setDate(today.getDate() + 7)).toISOString().split('T')[0];

        // 2. On récupère les employés dont le contrat finit exactement à ces dates
        const { data: emps, error } = await supabase
            .from('employees')
            .select('id, nom, email, poste, date_fin_contrat, manager_id, user_associated_id')
            .in('date_fin_contrat', [in30Days, in7Days])
            .not('statut', 'ilike', '%Sortie%');

        if (error) throw error;

        for (const emp of emps) {
            const daysLeft = (emp.date_fin_contrat === in30Days) ? 30 : 7;

            // --- A. ENVOI EMAIL À L'EMPLOYÉ (Information) ---
            const emailHtml = `
            <div style="font-family: sans-serif; color: #1e293b; max-width: 500px; margin: auto; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden;">
                <div style="background-color: #0f172a; padding: 25px; text-align: center;">
                    <img src="https://cdn-icons-png.flaticon.com/512/9752/9752284.png" style="width: 50px;">
                </div>
                <div style="padding: 30px;">
                    <h2 style="color: #0f172a;">Suivi de votre contrat</h2>
                    <p>Bonjour <b>${emp.nom}</b>,</p>
                    <p>Ce message automatique vous informe que votre contrat actuel arrive à échéance le <b>${new Date(emp.date_fin_contrat).toLocaleDateString('fr-FR')}</b> (dans ${daysLeft} jours).</p>
                    <p style="color: #64748b; font-size: 14px;">Le département RH et votre responsable ont été informés pour préparer la suite de votre collaboration.</p>
                </div>
            </div>`;
            
            await sendEmailAPI(emp.email, "Information relative à votre contrat", emailHtml);

            // --- B. NOTIFICATION PUSH AU SUPÉRIEUR (Action requise) ---
            if (emp.manager_id) {
                // On récupère l'ID utilisateur du manager pour lui envoyer le Push
                const { data: manager } = await supabase
                    .from('employees')
                    .select('user_associated_id')
                    .eq('id', emp.manager_id)
                    .single();

                if (manager && manager.user_associated_id) {
                    const pushTitle = daysLeft === 30 ? "📋 Échéance Contrat" : "⚠️ URGENCE CONTRAT";
                    const pushBody = `${emp.nom} (${emp.poste}) arrive en fin de contrat dans ${daysLeft} jours. Veuillez statuer sur le renouvellement.`;
                    
                    await sendPushNotification(manager.user_associated_id, pushTitle, pushBody, "/#employees");
                }
            }
        }
        console.log(`✅ [ROBOT CONTRATS] Scan terminé. ${emps.length} alertes envoyées.`);
    } catch (err) {
        console.error("❌ [ROBOT CONTRATS] Erreur :", err.message);
    }
});

module.exports = startCronJobs;
