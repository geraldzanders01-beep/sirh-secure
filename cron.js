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

module.exports = startCronJobs;
