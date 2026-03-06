const cron = require('node-cron');
const supabase = require('./supabaseClient');
const pLimit = require('p-limit');
const limit = pLimit(5);

const startCronJobs = () => {
    // Le CRON tourne TOUTES LES HEURES à la minute 0 (ex: 18h00, 19h00, 20h00...)
    cron.schedule('0 * * * *', async () => {
        console.log("⏰ [CRON] Vérification des clôtures automatiques...");
        
        const nowBenin = new Date(new Date().getTime() + (1 * 60 * 60 * 1000));
        const currentHour = nowBenin.getUTCHours();
        const nowMs = nowBenin.getTime();

        try {
            // 1. On cherche tous les employés qui sont actuellement "En Poste"
            const { data: enPoste, error } = await supabase
                .from('employees')
                .select('id, nom, employee_type')
                .eq('statut', 'En Poste');

            if (error || !enPoste || enPoste.length === 0) return;

            // 2. On récupère leur dernier pointage pour vérifier depuis combien de temps ils travaillent
            const ids = enPoste.map(e => e.id);
            const { data: lastPointages } = await supabase
                .from('pointages')
                .select('employee_id, heure')
                .in('employee_id', ids)
                .eq('action', 'CLOCK_IN')
                .order('heure', { ascending: false });

            const tasks = enPoste.map(emp => limit(async () => {
                let shouldClose = false;
                
                // On cherche l'heure de son entrée
                const sonPointage = lastPointages.find(p => p.employee_id === emp.id);
                if (!sonPointage) return; // Anomalie, on ignore
                
                const shiftDurationHours = (nowMs - new Date(sonPointage.heure).getTime()) / (1000 * 60 * 60);

                // --- ⚖️ LES 3 RÈGLES MÉTIER ---
                
                if (emp.employee_type === 'OFFICE') {
                    // RÈGLE BUREAU : Clôture si on dépasse 20h00 OU s'il travaille depuis plus de 12h
                    if (currentHour >= 20 || shiftDurationHours > 12) shouldClose = true;
                } 
                else if (emp.employee_type === 'MOBILE') {
                    // RÈGLE TERRAIN : Clôture à 02h00 du matin OU s'il travaille depuis plus de 15h
                    if (currentHour === 2 || currentHour === 3 || shiftDurationHours > 15) shouldClose = true;
                } 
                else if (emp.employee_type === 'FIXED' || emp.employee_type === 'SECURITY') {
                    // RÈGLE GARDIEN/NUIT : Uniquement basé sur la durée maximale (16h max)
                    if (shiftDurationHours > 16) shouldClose = true;
                }

                // --- 🛑 EXÉCUTION DE LA CLÔTURE ---
                if (shouldClose) {
                    // A. On pointe la sortie
                    await supabase.from('pointages').insert([{
                        employee_id: emp.id,
                        action: 'CLOCK_OUT',
                        heure: new Date().toISOString(),
                        is_final_out: true,
                        zone_detectee: "AUTO_CLOSURE"
                    }]);

                    // B. On libère l'agent
                    await supabase.from('employees').update({ statut: 'Actif' }).eq('id', emp.id);
                    
                    console.log(`🤖 Auto-clôture appliquée pour : ${emp.nom} (${emp.employee_type}) - Heures écoulées : ${shiftDurationHours.toFixed(1)}h`);
                }
            }));

            await Promise.all(tasks);

        } catch (err) { 
            console.error("❌ Erreur critique Cron :", err); 
        }
    });
};

module.exports = startCronJobs;
