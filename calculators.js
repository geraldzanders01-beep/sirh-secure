const supabase = require("./supabaseClient");

const Aggregators = {
    // 1. Compter les visites validées sur le mois
    countVisits: async (empId, startDate, endDate) => {
        const { count, error } = await supabase
            .from('visit_reports')
            .select('*', { count: 'exact', head: true })
            .eq('employee_id', empId)
            .gte('check_in_time', startDate)
            .lte('check_in_time', endDate)
            .not('check_out_time', 'is', null); // Seulement les visites terminées
        return error ? 0 : count;
    },

    // 2. Calculer le cumul d'heures réelles travaillées
    calculateHours: async (empId, startDate, endDate) => {
        const { data, error } = await supabase
            .from('pointages')
            .select('heure, action')
            .eq('employee_id', empId)
            .gte('heure', startDate)
            .lte('heure', endDate)
            .order('heure', { ascending: true });

        if (error || !data) return 0;

        let totalMinutes = 0;
        let lastIn = null;

        data.forEach(p => {
            if (p.action === 'CLOCK_IN') lastIn = new Date(p.heure);
            else if (p.action === 'CLOCK_OUT' && lastIn) {
                totalMinutes += (new Date(p.heure) - lastIn) / 60000;
                lastIn = null;
            }
        });
        return (totalMinutes / 60).toFixed(2); // Retourne les heures (ex: 160.5)
    },

    // 3. Compter les retards (ex: après 08:15)
    countLates: async (empId, startDate, endDate, limitTime = "08:15") => {
        const { data } = await supabase
            .from('pointages')
            .select('heure')
            .eq('employee_id', empId)
            .eq('action', 'CLOCK_IN')
            .gte('heure', startDate)
            .lte('heure', endDate);

        let lates = 0;
        data?.forEach(p => {
            const time = new Date(p.heure).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
            if (time > limitTime) lates++;
        });
        return lates;
    }
};

module.exports = Aggregators;
