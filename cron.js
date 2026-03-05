const cron = require('node-cron');
const supabase = require('./supabaseClient');
const pLimit = require('p-limit');
const limit = pLimit(5);

const startCronJobs = () => {
    // Tous les jours à 22h00 (Heure de l'Afrique de l'Ouest / Bénin)
    cron.schedule('0 22 * * *', async () => {
        console.log("⏰ Lancement du job de clôture auto...");
        try {
            // 1. Chercher tous les employés actuellement "En Poste"
            const { data: enPoste, error } = await supabase
                .from('employees')
                .select('id, employee_type')
                .eq('statut', 'En Poste');

            if (error) throw error;
            if (!enPoste || enPoste.length === 0) {
                console.log("✅ Aucun agent à clôturer.");
                return;
            }

            console.log(`🔍 ${enPoste.length} agent(s) en poste trouvés.`);

            // 2. Traitement avec limitation (5 requêtes en parallèle max)
            const tasks = enPoste.map(emp => limit(async () => {
                // On ignore les agents de sécurité ou fixes qui font des nuits
                if (emp.employee_type === 'FIXED' || emp.employee_type === 'SECURITY') return;

                // A. Insérer le pointage de sortie (CLOCK_OUT final)
                const { error: insertErr } = await supabase.from('pointages').insert([{
                    employee_id: emp.id,
                    action: 'CLOCK_OUT',
                    heure: new Date().toISOString(),
                    is_final_out: true,
                    zone_detectee: "AUTO_CLOSURE"
                }]);

                if (insertErr) {
                    console.error(`❌ Erreur pointage pour ${emp.id}:`, insertErr.message);
                    return;
                }

                // B. Mettre à jour le statut de l'employé à "Actif"
                const { error: updateErr } = await supabase
                    .from('employees')
                    .update({ statut: 'Actif' })
                    .eq('id', emp.id);

                if (!updateErr) {
                    console.log(`✅ Agent ${emp.id} clôturé automatiquement.`);
                }
            }));

            await Promise.all(tasks);
            console.log("🏁 Job de clôture terminé.");

        } catch (err) { 
            console.error("❌ Erreur critique Cron :", err); 
        }
    }, {
        scheduled: true,
        timezone: "Africa/Porto-Novo" // GARANTIT L'HEURE LOCALE
    });
};

module.exports = startCronJobs;
