const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const { checkPerm, getDistanceInMeters } = require("../utils");


router.all("/clock", async (req, res) => {
    // 1. VÉRIFICATION PERMISSION
    if (!checkPerm(req, 'can_clock')) {
        return res.status(403).json({ error: "Vous n'avez pas l'autorisation de pointer." });
    }

    // 2. EXTRACTION ET NETTOYAGE DES DONNÉES (Gestion ultra-robuste JSON/FormData)
    const getVal = (val) => Array.isArray(val) ? val[0] : val;

    // On cherche l'ID et l'Action partout (body ou query) pour éviter le "undefined"
    const id = getVal(req.body.id || req.body.employee_id || req.query.id);
    const clockAction = getVal(req.body.action || req.query.action);
    const gps = getVal(req.body.gps) || "0,0";
    const time = getVal(req.body.time);
    const outcome = getVal(req.body.outcome);
    const report = getVal(req.body.report);
    const is_last_exit = getVal(req.body.is_last_exit);
    const schedule_id = getVal(req.body.schedule_id);
    const forced_location_id = getVal(req.body.forced_location_id);
    const prescripteur_id = getVal(req.body.prescripteur_id);
    const contact_nom_libre = getVal(req.body.contact_nom_libre);
    let rawProducts = getVal(req.body.presentedProducts);

    console.log(`📍 Pointage: ID [${id}] - Action [${clockAction}] - GPS [${gps}]`);

    if (!id || id === "undefined" || id === "null") {
        console.error("❌ Erreur: ID manquant dans req.body:", req.body);
        return res.status(400).json({ error: "Identifiant employé manquant." });
    }

    const eventTime = time ? new Date(time) : new Date();
    const today = eventTime.toISOString().split('T')[0];
    
    // Découpage sécurisé du GPS
    const gpsString = String(gps);
    const [userLat, userLon] = gpsString.includes(',') ? gpsString.split(',').map(parseFloat) : [0, 0];

    try {
        // 3. IDENTIFICATION DE L'EMPLOYÉ
        const { data: emp, error: empErr } = await supabase
            .from('employees')
            .select('*')
            .eq('id', id.trim())
            .maybeSingle();

        if (empErr) throw empErr;
        if (!emp) {
            console.error(`❌ ÉCHEC : L'ID [${id}] n'existe pas dans la table employees.`);
            return res.status(404).json({ error: "Employé introuvable dans la base de données." });
        }

        const isMobileAgent = (emp.employee_type === 'MOBILE');

        // 4. VERROU DE SÉCURITÉ : JOURNÉE DÉJÀ CLÔTURÉE
        const { data: finalRecord } = await supabase.from('pointages')
            .select('id')
            .eq('employee_id', emp.id)
            .eq('is_final_out', true)
            .gte('heure', `${today}T00:00:00`)
            .maybeSingle();

        if (finalRecord) {
            return res.status(403).json({ error: "Votre journée est déjà clôturée. Plus de pointage possible aujourd'hui." });
        }

        // 5. TRAITEMENT DE LA PHOTO DE PREUVE (Fichier OU Base64)
        let proofUrl = null;
        
        // A. Cas du fichier envoyé via FormData (Multer)
        if (req.files && req.files.length > 0) {
            const file = req.files.find(f => f.fieldname === 'proof_photo');
            if (file) {
                const fileName = `VISITE_ID${emp.id}_${Date.now()}.jpg`;                    
                const { error: upErr } = await supabase.storage.from('documents').upload(fileName, file.buffer, { contentType: file.mimetype });
                if (!upErr) proofUrl = supabase.storage.from('documents').getPublicUrl(fileName).data.publicUrl;
            }
        } 
        // B. Cas du Base64 envoyé via JSON
        else if (req.body.proof_photo_base64) {
            const base64Data = req.body.proof_photo_base64.replace(/^data:image\/\w+;base64,/, "");
            const buffer = Buffer.from(base64Data, 'base64');
            const fileName = `VISITE_JSON_ID${emp.id}_${Date.now()}.jpg`;
            const { error: upErr } = await supabase.storage.from('documents').upload(fileName, buffer, { contentType: 'image/jpeg' });
            if (!upErr) proofUrl = supabase.storage.from('documents').getPublicUrl(fileName).data.publicUrl;
        }

    // 6. LOGIQUE GPS (Version Vice-Versa : Synchronisation Totale PC/Mobile)
        let detectedLocName = "Zone Mobile";
        let detectedLocId = null;

        const userAgent = req.headers['user-agent'] || "";
        const isMobileDevice = /Mobile|Android|iPhone|iPad/i.test(userAgent);

        if (forced_location_id && clockAction === 'CLOCK_IN') {
            const { data: loc } = await supabase.from('mobile_locations').select('*').eq('id', forced_location_id).single();
            if (loc) {
                const dist = getDistanceInMeters(userLat, userLon, loc.latitude, loc.longitude);
                if (dist <= (loc.radius || 100)) {
                    detectedLocName = loc.name;
                    detectedLocId = loc.id;
                }
            }
        } else {
            const [zonesRes, mobilesRes] = await Promise.all([
                supabase.from('zones').select('*').eq('actif', true),
                supabase.from('mobile_locations').select('*').eq('is_active', true)
            ]);

            let allPlaces = [];
            if (zonesRes.data) zonesRes.data.forEach(z => {
                allPlaces.push({ id: z.id, name: z.nom, lat: z.latitude, lon: z.longitude, radius: z.rayon, isOffice: true });
            });
            if (mobilesRes.data) mobilesRes.data.forEach(m => {
                allPlaces.push({ id: m.id, name: m.name, lat: m.latitude, lon: m.longitude, radius: m.radius, isOffice: false });
            });
            
            for (let loc of allPlaces) {
                const dist = getDistanceInMeters(userLat, userLon, loc.lat, loc.lon);
                
                // --- CALCUL DU RAYON AVEC GESTION DU VICE-VERSA ---
                let effectiveRadius = loc.radius || 100;

                if (loc.isOffice) {
                    // Pour les bureaux, on accepte l'écart de 1.5km pour TOUT LE MONDE.
                    // Cela règle le problème si le point a été créé sur PC et qu'on pointe sur Mobile (ou l'inverse).
                    effectiveRadius = 1500; 
                } else {
                    // Pour le terrain (Pharmacies, etc.), on reste strict sur Mobile.
                    if (isMobileDevice) {
                        effectiveRadius = 100; 
                    } else {
                        effectiveRadius = 1500; // Tolérance si un manager vérifie sur PC
                    }
                }
                // ---------------------------------------------------

                if (dist <= effectiveRadius) {
                    detectedLocName = loc.name;
                    detectedLocId = loc.isOffice ? null : loc.id;
                    console.log(`✅ Pointage validé : ${loc.name} | Appareil: ${isMobileDevice ? 'Mobile' : 'PC'} | Distance: ${Math.round(dist)}m | Rayon utilisé: ${effectiveRadius}m`);
                    break;
                }
            }
        }

        if (!isMobileAgent && detectedLocName === "Zone Mobile") {
            return res.status(403).json({ error: "Vous n'êtes sur aucun site autorisé." });
        }

        // 7. ENREGISTREMENT DU POINTAGE
        const isFinal = (clockAction === 'CLOCK_OUT' && (is_last_exit === 'true' || is_last_exit === true || !isMobileAgent));

        const { error: ptgErr } = await supabase.from('pointages').insert([{
            employee_id: emp.id,
            action: clockAction,
            heure: eventTime.toISOString(),
            gps_lat: userLat,
            gps_lon: userLon,
            zone_detectee: detectedLocName,
            ip_address: req.body.ip || "0.0.0.0",
            statut: 'Validé',
            is_final_out: isFinal
        }]);
        if (ptgErr) throw ptgErr;

// 8. LOGIQUE VISITE (Si Mobile) - VERSION ROBUSTE
        if (isMobileAgent) {
            if (clockAction === 'CLOCK_IN') {
                console.log(`📝 Création d'un rapport de visite pour ${emp.nom} à ${detectedLocName}`);
                
                // ON RETIRE 'statut_visite' car la colonne n'existe pas dans ta DB
                const { error: visitErr } = await supabase.from('visit_reports').insert([{
                    employee_id: emp.id, 
                    check_in_time: eventTime.toISOString(),
                    location_name: detectedLocName,
                    location_id: detectedLocId || null,
                    schedule_ref_id: schedule_id || null
                }]);

                if (visitErr) {
                    console.error("❌ Erreur critique Supabase (IN):", visitErr.message);
                }

                await supabase.from('employees').update({ statut: 'En Poste' }).eq('id', emp.id);
            } 
// 8. LOGIQUE VISITE (Si Mobile) - VERSION FINALISÉE ET SÉCURISÉE
        if (isMobileAgent) {
            if (clockAction === 'CLOCK_IN') {
                console.log(`📝 [IN] Création rapport pour ${emp.nom} à ${detectedLocName}`);
                
                const { data: newVisit, error: visitErr } = await supabase.from('visit_reports').insert([{
                    employee_id: emp.id, 
                    check_in_time: eventTime.toISOString(),
                    location_name: detectedLocName,
                    location_id: (detectedLocId && detectedLocId !== 'undefined') ? detectedLocId : null,
                    schedule_ref_id: (schedule_id && schedule_id !== 'undefined') ? schedule_id : null
                }]).select();

                if (visitErr) {
                    console.error("❌ [ERREUR IN] Supabase a refusé la création :", visitErr.message);
                } else {
                    console.log("✅ [IN] Ligne créée dans visit_reports. ID:", newVisit[0].id);
                }

                await supabase.from('employees').update({ statut: 'En Poste' }).eq('id', emp.id);
            } 
          else if (clockAction === 'CLOCK_OUT') {
                console.log(`📝 [OUT] Tentative de clôture pour ${emp.nom}`);

                // 1. Recherche de la visite ouverte la plus récente
                const { data: lastVisit, error: fetchErr } = await supabase.from('visit_reports')
                    .select('id, check_in_time')
                    .eq('employee_id', emp.id)
                    .is('check_out_time', null)
                    .order('check_in_time', { ascending: false })
                    .limit(1)
                    .maybeSingle();

                if (fetchErr) console.error("❌ [ERREUR FETCH] :", fetchErr.message);

                if (lastVisit) {
                    const dur = Math.round((eventTime - new Date(lastVisit.check_in_time)) / 60000);
                    
                    // --- 💥 FIX CRITIQUE : CONVERSION POUR TEXT[] 💥 ---
                    let productsArray = [];
                    try {
                        if (rawProducts) {
                            const raw = (typeof rawProducts === 'string') ? JSON.parse(rawProducts) : rawProducts;
                            // Ta DB attend des textes simples. On extrait juste le NOM des produits.
                            if (Array.isArray(raw)) {
                                productsArray = raw.map(p => (typeof p === 'string') ? p : (p.name || p.NAME || "Produit"));
                            }
                        }
                    } catch(e) { console.error("⚠️ Erreur format produits"); }

                    // --- SÉCURISATION DES UUID (Si pas un UUID valide, on met null) ---
                    const isValidUUID = (uuid) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);
                    
                    const cleanPrescripteurId = isValidUUID(prescripteur_id) ? prescripteur_id : null;
                    const cleanContactNom = (contact_nom_libre && contact_nom_libre !== 'undefined') ? contact_nom_libre : null;

                    // 2. Mise à jour de la ligne (Respect strict de ton schéma DB)
                    const updatePayload = {
                        check_out_time: eventTime.toISOString(),
                        outcome: outcome || 'VU',
                        notes: report || '',
                        proof_url: proofUrl || null,
                        duration_minutes: dur > 0 ? dur : 1,
                        presented_products: productsArray, // ✅ Maintenant c'est un tableau de strings ["A", "B"]
                        prescripteur_id: cleanPrescripteurId,
                        contact_nom_libre: cleanContactNom
                    };

                    const { error: updErr } = await supabase.from('visit_reports')
                        .update(updatePayload)
                        .eq('id', lastVisit.id);

                    if (updErr) {
                        console.error("❌ [ERREUR DB] Supabase refuse l'UPDATE :", updErr.message);
                    } else {
                        console.log(`✅ [SUCCÈS] Rapport ID ${lastVisit.id} mis à jour.`);
                    }
                } else {
                    console.warn("⚠️ [OUT] Aucune visite ouverte trouvée.");
                }

                if (isFinal) await supabase.from('employees').update({ statut: 'Actif' }).eq('id', emp.id);
            }
        }
        else {
            // Logique pour les non-Mobile (Sédentaires)
            await supabase.from('employees').update({ statut: clockAction === 'CLOCK_IN' ? 'En Poste' : 'Actif' }).eq('id', emp.id);
        }

        return res.json({ status: "success", zone: detectedLocName });

    } catch (err) {
        console.error("💥 CRASH ROUTE CLOCK:", err.message);
        return res.status(500).json({ error: "Erreur interne lors du pointage." });
    }
});
           
           // --- VÉRIFICATION ÉTAT POINTAGE (SIMPLIFIÉ) ---
router.all('/attendance-status', async (req, res) => {
    const { id } = req.body.id ? req.body : req.query; // Gère si l'ID est envoyé en GET ou POST

    try {
        // 1. Chercher le dernier pointage
        const { data: lastPointage } = await supabase
            .from('pointages')
            .select('action, is_final_out')
            .eq('employee_id', id)
            .order('heure', { ascending: false })
            .limit(1)
            .maybeSingle();

        // 2. LOGIQUE :
        // Si la journée est clôturée (is_final_out == true), on bloque tout (DONE)
        if (lastPointage && (lastPointage.is_final_out === true || lastPointage.is_final_out === 'true')) {
            return res.json({ action: 'DONE', can_clock: false });
        }
        
        // Si le dernier pointage est un IN, alors le délégué est en visite, il doit sortir (CLOCK_OUT)
        if (lastPointage && lastPointage.action === 'CLOCK_IN') {
            return res.json({ action: 'CLOCK_OUT', can_clock: true });
        }

        // Sinon (dernière action est OUT ou c'est le début de journée), il doit entrer (CLOCK_IN)
        return res.json({ action: 'CLOCK_IN', can_clock: true });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});


router.all("/get-clock-status", async (req, res) => {
  const { employee_id } = req.query;

  // 1. GESTION DU FUSEAU HORAIRE (BÉNIN = UTC+1)
  const nowUTC = new Date();
  const nowBenin = new Date(nowUTC.getTime() + (1 * 60 * 60 * 1000));
  const todayStr = nowBenin.toISOString().split("T")[0]; 

  try {
    // 2. Récupérer l'employé et son type
    const { data: emp } = await supabase
      .from("employees")
      .select("employee_type")
      .eq("id", employee_id)
      .single();
      
    if (!emp) return res.status(404).json({ error: "Employé non trouvé" });

    const isGuard = emp.employee_type === "FIXED" || emp.employee_type === "SECURITY";
    const isOffice = emp.employee_type === "OFFICE";

    // 3. VÉRIFICATION : Clôture FINALE AUJOURD'HUI ? (Faite manuellement ou par le CRON)
    const { data: finalToday } = await supabase
      .from("pointages")
      .select("id")
      .eq("employee_id", employee_id)
      .eq("is_final_out", true)
      .gte("heure", `${todayStr}T00:00:00`)
      .maybeSingle();

    if (finalToday) {
      return res.json({ status: "DONE", day_finished: true });
    }

    // 4. RÉCUPÉRER LE DERNIER POINTAGE
    const { data: lastRecord } = await supabase
      .from("pointages")
      .select("action, heure")
      .eq("employee_id", employee_id)
      .order("heure", { ascending: false })
      .limit(1)
      .maybeSingle();

    let status = "OUT";
    let isDayFinished = false;

    if (lastRecord) {
      const lastTimeUTC = new Date(lastRecord.heure);
      const diffHours = (nowUTC - lastTimeUTC) / (1000 * 60 * 60); 
      
      const lastTimeBenin = new Date(lastTimeUTC.getTime() + (1 * 60 * 60 * 1000));
      const lastDateStr = lastTimeBenin.toISOString().split("T")[0];

      if (lastRecord.action === "CLOCK_IN") {
        // Définition des limites de shift (doit correspondre au CRON)
        let maxShift = 14;
        if (isGuard) maxShift = 17;

        if (diffHours >= maxShift) {
            // S'il a dépassé la limite absolue, le CRON va le fermer (ou l'a déjà fermé)
            // On débloque le bouton pour qu'il puisse reprendre une nouvelle journée normale.
            status = "OUT";
        } else {
            // S'il est entré HIER et qu'il n'est pas Gardien de nuit, c'est un oubli.
            if (!isGuard && lastDateStr !== todayStr) {
                status = "OUT";
            } else {
                status = "IN"; // Il est en poste normal
            }
        }
      } 
      else if (lastRecord.action === "CLOCK_OUT") {
        // Sédentaires (OFFICE) : 1 Sortie = Fin de journée.
        // Mobiles / Gardiens : Peuvent faire plusieurs Entrées/Sorties.
        if (isOffice && lastDateStr === todayStr) {
          status = "DONE";
          isDayFinished = true;
        } else {
          status = "OUT";
        }
      }
    }

    return res.json({
      status: status,
      employee_type: emp.employee_type,
      day_finished: isDayFinished,
    });
    
  } catch (err) {
    console.error("Erreur status:", err.message);
    return res.status(500).json({ error: err.message });
  }
});


router.all("/live-attendance", async (req, res) => {
  try {
    const todayStr = new Date().toISOString().split("T")[0];
    const currentUserId = req.user.emp_id;

    // 1. Récupérer le périmètre du manager
    const { data: requester } = await supabase
      .from("employees")
      .select("hierarchy_path, management_scope")
      .eq("id", currentUserId)
      .single();

    // 2. Construire la requête filtrée pour les employés
    // MODIFICATION : On ajoute "En Poste" à la liste des statuts suivis
    let empQuery = supabase
      .from("employees")
      .select("id, nom, poste, photo_url, statut, hierarchy_path")
      .or("statut.eq.Actif,statut.eq.Congé,statut.eq.En Poste");

    if (!checkPerm(req, "can_see_employees")) {
      let conditions = [];
      conditions.push(`hierarchy_path.eq.${requester.hierarchy_path}`);
      conditions.push(`hierarchy_path.ilike.${requester.hierarchy_path}/%`);
      if (requester.management_scope?.length > 0) {
        const scopeList = `(${requester.management_scope.map((s) => `"${s}"`).join(",")})`;
        conditions.push(`departement.in.${scopeList}`);
      }
      empQuery = empQuery.or(conditions.join(","));
    }

    const { data: emps } = await empQuery;

    // 3. Récupérer les pointages du jour
    const { data: pointages } = await supabase
      .from("pointages")
      .select("*")
      .gte("heure", `${todayStr}T00:00:00`);

    const status = { presents: [], partis: [], absents: [] };

    // Dans server.js, route 'live-attendance'
    if (emps) {
      emps.forEach((e) => {
        const sesPointages = (pointages || []).filter(
          (p) => p.employee_id === e.id,
        );

        if (sesPointages.length === 0) {
          status.absents.push(e);
        } else {
          // Source de vérité : Le dernier pointage enregistré
          const dernier = sesPointages[sesPointages.length - 1];

          // RÈGLE UNIVERSELLE :
          // Si le dernier geste est une SORTIE et que c'est marqué comme FINAL
          if (
            dernier.action === "CLOCK_OUT" &&
            (dernier.is_final_out === true || dernier.is_final_out === "true")
          ) {
            status.partis.push(e); // Direction -> Carte Bleue (Journée terminée)
          }
          // Si le dernier geste est une ENTRÉE
          else if (dernier.action === "CLOCK_IN") {
            status.presents.push(e); // Direction -> Carte Verte (En poste)
          }
          // Cas Mobile : Sortie de pharmacie mais pas fin de journée
          else {
            status.presents.push(e); // Reste en Vert (En poste) car il va vers une autre pharmacie
          }
        }
      });
    }
    return res.json(status);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.all("/add-schedule", async (req, res) => {
  const {
    employee_id,
    location_id,
    schedule_date,
    start_time,
    end_time,
    notes,
    prescripteur_id,
  } = req.body;

  // 1. VÉRIFICATION DES DROITS
  // On a besoin soit d'être Manager (can_see_employees), soit d'avoir le droit planning (can_manage_schedules)
  const isManager =
    req.user.permissions && req.user.permissions.can_see_employees;
  const canSelfPlan =
    req.user.permissions && req.user.permissions.can_manage_schedules;

  if (!isManager && !canSelfPlan) {
    return res
      .status(403)
      .json({ error: "Vous n'avez pas le droit de créer des missions." });
  }

  // 2. RESTRICTION DE SÉCURITÉ
  // Si je ne suis PAS manager, je suis OBLIGÉ de créer la mission pour MOI-MÊME (mon ID).
  // Je ne peux pas créer une mission pour un collègue.
  if (!isManager && String(employee_id) !== String(req.user.emp_id)) {
    return res.status(403).json({
      error: "Interdit : Vous ne pouvez planifier que pour vous-même.",
    });
  }

  // 3. INSERTION
  const { data, error } = await supabase
    .from("employee_schedules")
    .insert([
      {
        employee_id,
        location_id: location_id || null,
        prescripteur_id: prescripteur_id || null,
        schedule_date,
        start_time,
        end_time,
        notes,
        status: "PENDING", // Statut par défaut : En attente (Gris)
      },
    ])
    .select();

  if (error) throw error;
  return res.json({ status: "success", data: data[0] });
});

router.all("/list-schedules", async (req, res) => {
  const perms = req.user.permissions || {};

  // 1. Définition des droits d'accès
  const canSeeAll = perms.can_see_employees; // Les managers voient tout
  const canSeeOwn = perms.can_manage_schedules; // Les délégués voient le leur

  // SÉCURITÉ : Si l'utilisateur n'a aucun des deux droits, dehors.
  if (!canSeeAll && !canSeeOwn) {
    return res.status(403).json({ error: "Accès refusé aux plannings" });
  }

  let query = supabase
    .from("employee_schedules")
    .select(
      `
                    *, 
                    employees(id, nom, matricule, employee_type, poste), 
                    mobile_locations(id, name, address, latitude, longitude, radius, type_location),
                    prescripteurs(id, nom_complet, fonction)
                `,
    )
    .order("schedule_date", { ascending: false })
    .order("start_time", { ascending: true });

  // 2. FILTRAGE : Si ce n'est pas un manager global, il ne voit que SES missions
  if (!canSeeAll) {
    query = query.eq("employee_id", req.user.emp_id);
  }

  const { data, error } = await query;
  if (error) throw error;

  // Mapping
  const mappedSchedules = data.map((s) => ({
    id: s.id,
    employee_id: s.employee_id,
    employee_name: s.employees ? s.employees.nom : "N/A",
    location_id: s.location_id,
    location_name: s.mobile_locations
      ? s.mobile_locations.name
      : "Lieu Inconnu",
    location_address: s.mobile_locations ? s.mobile_locations.address : "N/A",
    location_lat: s.mobile_locations ? s.mobile_locations.latitude : null,
    location_lon: s.mobile_locations ? s.mobile_locations.longitude : null,
    location_radius: s.mobile_locations ? s.mobile_locations.radius : null,
    prescripteur_id: s.prescripteur_id,
    prescripteur_nom: s.prescripteurs ? s.prescripteurs.nom_complet : null,
    prescripteur_fonction: s.prescripteurs ? s.prescripteurs.fonction : null,
    schedule_date: s.schedule_date,
    start_time: s.start_time,
    end_time: s.end_time,
    status: s.status,
    notes: s.notes,
  }));

  return res.json(mappedSchedules);
});

router.all("/update-schedule", async (req, res) => {
  if (!req.user.permissions || !req.user.permissions.can_see_employees) {
    return res
      .status(403)
      .json({ error: "Accès refusé à la modification de plannings" });
  }
  const {
    id,
    employee_id,
    location_id,
    schedule_date,
    start_time,
    end_time,
    status,
    notes,
  } = req.body;
  const { data, error } = await supabase
    .from("employee_schedules")
    .update({
      employee_id,
      location_id,
      schedule_date,
      start_time,
      end_time,
      status,
      notes,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select();
  if (error) throw error;
  return res.json({ status: "success", data: data[0] });
});

// D. Supprimer un planning (Manager OU Propriétaire du planning)
router.all("/delete-schedule", async (req, res) => {
  const { id } = req.body;
  const currentUserId = req.user.emp_id;
  const isManager =
    req.user.permissions && req.user.permissions.can_see_employees;

  // 1. On récupère le planning pour voir à qui il appartient
  const { data: schedule } = await supabase
    .from("employee_schedules")
    .select("employee_id")
    .eq("id", id)
    .single();

  if (!schedule) return res.status(404).json({ error: "Mission introuvable" });

  // 2. Vérification : Est-ce que j'ai le droit ?
  // J'ai le droit SI je suis Manager OU SI c'est mon propre ID
  if (!isManager && String(schedule.employee_id) !== String(currentUserId)) {
    return res.status(403).json({
      error: "Vous ne pouvez pas supprimer le planning d'un collègue.",
    });
  }

  const { error } = await supabase
    .from("employee_schedules")
    .delete()
    .eq("id", id);
  if (error) throw error;
  return res.json({ status: "success" });
});

router.all("/add-mobile-location", async (req, res) => {
  if (!checkPerm(req, "can_manage_mobile_locations")) {
    return res.status(403).json({
      error:
        "Accès refusé : Vous n'êtes pas autorisé à créer des prescripteurs.",
    });
  }
  const { name, address, latitude, longitude, radius, type_location } =
    req.body;
  const { data, error } = await supabase
    .from("mobile_locations")
    .insert([
      {
        name,
        address,
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        radius: parseInt(radius),
        type_location,
      },
    ])
    .select();
  if (error) throw error;
  return res.json({ status: "success", data: data[0] });
});

// B. Lister les lieux (CORRECTION : RETRAIT DU FILTRE QUI PLANTAIT)
router.all("/list-mobile-locations", async (req, res) => {
  const p = req.user.permissions || {};

  // 1. Droit d'entrée de base
  const canView =
    p.can_manage_config ||
    p.can_see_employees ||
    p.can_manage_schedules ||
    p.can_manage_mobile_locations;

  // Si l'utilisateur n'a aucun de ces droits, on bloque
  if (!canView) return res.status(403).json({ error: "Accès refusé." });

  // 2. Préparation de la requête
  // ON A RETIRÉ LE FILTRE 'created_by_id' QUI CAUSAIT L'ERREUR 500
  let query = supabase
    .from("mobile_locations")
    .select("*")
    .eq("is_active", true)
    .order("name", { ascending: true });

  const { data, error } = await query;
  if (error) throw error;
  return res.json(data);
});

router.all("/list-zones", async (req, res) => {
  if (!req.user.permissions || !req.user.permissions.can_manage_config) {
    return res.status(403).json({ error: "Accès refusé à la configuration" });
  }

  const { data, error } = await supabase
    .from("zones")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw error;
  return res.json(data);
});

// C. Mettre à jour un lieu mobile
router.all("/update-mobile-location", async (req, res) => {
  if (!req.user.permissions || !req.user.permissions.can_manage_config) {
    return res
      .status(403)
      .json({ error: "Accès refusé à la modification des lieux mobiles" });
  }
  const {
    id,
    name,
    address,
    latitude,
    longitude,
    radius,
    type_location,
    is_active,
  } = req.body;
  const { data, error } = await supabase
    .from("mobile_locations")
    .update({
      name,
      address,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      radius: parseInt(radius),
      type_location,
      is_active,
    })
    .eq("id", id)
    .select();
  if (error) throw error;
  return res.json({ status: "success", data: data[0] });
});

// D. Supprimer un lieu (RÉSERVÉ ADMIN/CONFIG UNIQUEMENT)
router.all("/delete-mobile-location", async (req, res) => {
  // Seul celui qui a le droit "Configuration" (Admin) peut supprimer
  if (!req.user.permissions || !req.user.permissions.can_manage_config) {
    return res.status(403).json({
      error:
        "Interdit. Seul l'administrateur peut supprimer un lieu de la base.",
    });
  }

  const { id } = req.body;
  const { error } = await supabase
    .from("mobile_locations")
    .delete()
    .eq("id", id);
  if (error) throw error;
  return res.json({ status: "success" });
});

router.all("/import-locations", async (req, res) => {
  if (!req.user.permissions.can_manage_config)
    return res.status(403).json({ error: "Interdit" });

  const { locations } = req.body; // Un tableau d'objets [{name, lat, lon, zone}, ...]

  // Insertion massive (Bulk Insert)
  const { error } = await supabase.from("mobile_locations").insert(locations);

  if (error) throw error;
  return res.json({ status: "success", count: locations.length });
});

router.all("/get-performance-report", async (req, res) => {
  const { start_date, end_date } = req.query;

  // On récupère la synthèse des visites groupées par employé et par lieu
  const { data, error } = await supabase
    .from("visit_reports")
    .select("*, employees(nom, matricule), mobile_locations(name, zone_name)")
    .gte("check_in_time", start_date)
    .lte("check_in_time", end_date);

  if (error) throw error;

  // On transforme les données pour le tableau de bord du Boss
  const stats = {};
  data.forEach((v) => {
    const empId = v.employee_id;
    if (!stats[empId]) {
      stats[empId] = {
        nom: v.employees.nom,
        matricule: v.employees.matricule,
        total_visites: 0,
        lieux: {},
      };
    }
    stats[empId].total_visites++;
    const locName = v.mobile_locations.name;
    stats[empId].lieux[locName] = (stats[empId].lieux[locName] || 0) + 1;
  });

  return res.json(Object.values(stats));
});

router.all("/add-zone", async (req, res) => {
  if (!req.user.permissions || !req.user.permissions.can_manage_config) {
    return res.status(403).json({ error: "Accès refusé à la configuration" });
  }

  const { nom, lat, lon, rayon } = req.body;

  // On utilise les noms exacts de tes colonnes : latitude et longitude
  const { error } = await supabase.from("zones").insert([
    {
      nom: nom,
      latitude: parseFloat(lat),
      longitude: parseFloat(lon),
      rayon: parseInt(rayon),
      actif: true,
    },
  ]);

  if (error) {
    console.error("Erreur ajout zone:", error.message);
    throw error;
  }
  return res.json({ status: "success" });
});

router.all("/delete-zone", async (req, res) => {
  if (!req.user.permissions || !req.user.permissions.can_manage_config) {
    return res.status(403).json({ error: "Accès refusé à la configuration" });
  }

  const { id } = req.body;
  const { error } = await supabase.from("zones").delete().eq("id", id);
  if (error) throw error;
  return res.json({ status: "success" });
});



router.all("/read-config", async (req, res) => {
  const { data, error } = await supabase
    .from("zones")
    .select("nom, latitude, longitude, rayon") // On ne prend que le strict nécessaire
    .eq("actif", true);

  if (error) throw error;

  const mapped = data.map((z) => ({
    Nom: z.nom,
    Latitude: z.latitude,
    Longitude: z.longitude,
    Rayon: z.rayon,
  }));
  return res.json(mapped);
});

// --- IMPORT MASSIF DE ZONES / SIÈGES (CSV) ---
router.all("/import-zones", async (req, res) => {
  if (!req.user.permissions.can_manage_config)
    return res.status(403).json({ error: "Interdit" });

  const { zones } = req.body; // [{nom, latitude, longitude, rayon}, ...]

  // Insertion massive
  const { error } = await supabase.from("zones").insert(zones);

  if (error) {
    console.error("Erreur Import Zones:", error.message);
    throw error;
  }
  return res.json({ status: "success", count: zones.length });
});

router.all("/read-visit-reports", async (req, res) => {
  try {
    // Paramètres de pagination
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    // 1. Initialisation de la requête
    let query = supabase.from("visit_reports").select(
      `
                    *,
                    employees:employee_id (nom),
                    mobile_locations:location_id (name),
                    prescripteurs:prescripteur_id (nom_complet, fonction) 
                `,
      { count: "exact" },
    );
   query = query.not('check_out_time', 'is', null); // On ne montre que les visites TERMINEÉES

    // --- FILTRE DE SÉCURITÉ AMÉLIORÉ ---
    const isPersonalRequest = req.query.personal === "true"; // On vérifie si le front demande le mode perso
    const canSeeAll =
      req.user.permissions &&
      (req.user.permissions.can_view_reports ||
        req.user.role === "ADMIN" ||
        req.user.role === "RH");

    if (isPersonalRequest) {
      // Mode Historique Perso : On voit tout son propre travail, même validé
      query = query.eq("employee_id", req.user.emp_id);
    } else if (!canSeeAll) {
      // Simple employé sans droits : Ne voit que lui-même
      query = query.eq("employee_id", req.user.emp_id);
    } else {
      // Manager en mode "Gestion" : Ne voit que ce qui n'est pas encore traité
      query = query.not("hidden_for_manager", "is", true);
    }

    // 2. Exécution avec pagination et tri
    const { data, error, count } = await query
      .order("check_in_time", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const cleanData = data.map((v) => {
      // Logique intelligente pour le nom du contact (S'il est dans la base ou tapé à la main)
      let doctorName = "Contact non précisé";
      let doctorRole = "";

      if (v.prescripteurs && v.prescripteurs.nom_complet) {
        doctorName = v.prescripteurs.nom_complet;
        doctorRole = v.prescripteurs.fonction || "Professionnel de santé";
      } else if (v.contact_nom_libre) {
        doctorName = v.contact_nom_libre;
        doctorRole = "Nouveau contact (Non répertorié)";
      }

      return {
        id: v.id,
        employee_id: v.employee_id,
        nom_agent: v.employees?.nom || "Agent inconnu",
        lieu_nom: v.location_name || v.mobile_locations?.name || "Lieu inconnu",
        contact_nom: doctorName,
        contact_role: doctorRole,
        check_in: v.check_in_time,
        check_out: v.check_out_time,
        outcome: v.outcome,
        duration: v.duration_minutes,
        notes: v.notes,
        proof_url: v.proof_url,
        presented_products: v.presented_products,
      };
    });

    // On renvoie les données ET les infos de pagination
    return res.json({
      data: cleanData,
      meta: {
        total: count,
        page: page,
        last_page: Math.ceil(count / limit),
      },
    });
  } catch (err) {
    console.error("Erreur rapports:", err.message);
    return res.status(500).json({ error: err.message });
  }
});




// ============================================================
// 11. AUDIT GLOBAL D'ACTIVITÉ (DÉLÉGUÉS)
// ============================================================
router.all("/get-global-audit", async (req, res) => {
    // Vérification de sécurité : Seul un Admin ou RH peut voir l'audit global
    if (!checkPerm(req, "can_see_audit") && !checkPerm(req, "can_see_employees")) {
        return res.status(403).json({ error: "Accès refusé à l'audit global" });
    }

    const { month, year } = req.query;
    if (!month || !year) {
        return res.status(400).json({ error: "Paramètres mois et année manquants." });
    }

    const paddedMonth = String(month).padStart(2, '0');
    const searchPattern = `${year}-${paddedMonth}`; 

    try {
        // 1. Récupération des données de base
        // On ne prend que les employés de type MOBILE (Délégués)
        const { data: emps } = await supabase
            .from('employees')
            .select('id, nom, matricule, poste')
            .eq('employee_type', 'MOBILE'); 

        // Optimisation : On filtre par date directement si possible, sinon on filtre en JS
        const { data: visits } = await supabase.from('visit_reports').select('*');
        const { data: leaves } = await supabase.from('conges').select('*').eq('statut', 'Validé');
        const { data: dailies } = await supabase.from('daily_reports').select('*');

        if (!emps) return res.json([]);

        // 2. Traitement des statistiques par employé
        const auditReport = emps.map(e => {
            // Filtrage des visites du mois pour cet employé
            const sesVisites = (visits || []).filter(v => {
                const dateToCheck = v.check_out_time || v.check_in_time || v.created_at;
                return v.employee_id === e.id && dateToCheck && dateToCheck.includes(searchPattern);
            });

            const statsLieux = {};
            const nomsProduitsUniques = new Set(); 
            let totalProduitsCount = 0;

            sesVisites.forEach(v => {
                const nameLieu = v.location_name || "Site inconnu";
                statsLieux[nameLieu] = (statsLieux[nameLieu] || 0) + 1;

                // --- GESTION DES PRODUITS ---
                let prods = [];
                try {
                    if (typeof v.presented_products === 'string') prods = JSON.parse(v.presented_products);
                    else if (Array.isArray(v.presented_products)) prods = v.presented_products;
                } catch(err) { prods = []; }
                
                if (Array.isArray(prods)) {
                    totalProduitsCount += prods.length;
                    prods.forEach(p => {
                        let pName = "Produit";
                        if (typeof p === 'object' && p !== null) {
                            pName = p.name || p.NAME || p.Name;
                        } else if (typeof p === 'string') {
                            // Décodage si c'est un JSON stringifié (ton bug)
                            if (p.startsWith('{')) {
                                try { 
                                    const obj = JSON.parse(p); 
                                    pName = obj.name || obj.NAME || "Produit"; 
                                } catch(e) { pName = p; }
                            } else {
                                pName = p;
                            }
                        }
                        if (pName) nomsProduitsUniques.add(pName.trim());
                    });
                }
            });

            // Formatage des détails
            const detailLieux = Object.entries(statsLieux)
                .map(([n, c]) => `${n} (${c})`)
                .join(', ') || "Aucune visite";
                
            const detailProduits = Array.from(nomsProduitsUniques).join(', ') || "Aucun produit présenté";

            // --- GESTION DES CONGÉS (Calcul des jours) ---
            const sesConges = (leaves || []).filter(l => l.employee_id === e.id && l.date_debut && l.date_debut.includes(searchPattern));
            let joursAbsence = 0;
            sesConges.forEach(l => {
                const d1 = new Date(l.date_debut);
                const d2 = new Date(l.date_fin);
                if (!isNaN(d1) && !isNaN(d2)) {
                    joursAbsence += Math.ceil(Math.abs(d2 - d1) / (1000 * 60 * 60 * 24)) + 1;
                }
            });

            // --- DERNIER RAPPORT JOURNALIER ---
            const sesDailies = (dailies || []).filter(d => d.employee_id === e.id && d.report_date && d.report_date.includes(searchPattern));

            return {
                matricule: e.matricule || 'N/A',
                nom: e.nom,
                poste: e.poste || 'Délégué',
                total_visites: sesVisites.length,
                total_produits: totalProduitsCount,
                detail_lieux: detailLieux,
                detail_produits: detailProduits, 
                jours_absence: joursAbsence,
                dernier_rapport: sesDailies.length > 0 ? sesDailies[sesDailies.length - 1].summary : "Rien à signaler"
            };
        });

        return res.json(auditReport);

    } catch (err) {
        console.error("Erreur Audit Global:", err.message);
        return res.status(500).json({ error: err.message });
    }
});



// MASQUER UN BILAN JOURNALIER (ACTION CHEF)
router.all("/delete-daily-report", async (req, res) => {
  const { id } = req.body;
  const { error } = await supabase
    .from("daily_reports")
    .update({ hidden_for_manager: true })
    .eq("id", id);
  if (error) throw error;
  return res.json({ status: "success" });
});

router.all("/read-daily-reports", async (req, res) => {
  try {
    // 1. Paramètres de pagination (Standardisation pour le long terme)
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    // 2. Initialisation de la requête avec jointure explicite
    let query = supabase
      .from("daily_reports")
      .select("*, employees:employee_id (nom, matricule, poste)", {
        count: "exact",
      });

    // --- FILTRE DE SÉCURITÉ AMÉLIORÉ ---
    const isPersonalRequest = req.query.personal === "true";
    const canSeeAll =
      req.user.permissions &&
      (req.user.permissions.can_view_reports ||
        req.user.role === "ADMIN" ||
        req.user.role === "RH");

    if (isPersonalRequest) {
      query = query.eq("employee_id", req.user.emp_id);
    } else if (!canSeeAll) {
      query = query.eq("employee_id", req.user.emp_id);
    } else {
      query = query.not("hidden_for_manager", "is", true);
    }

    // 3. Exécution avec tri, pagination et plage (range)
    const { data, error, count } = await query
      .order("report_date", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    // 4. Renvoi des données avec les métadonnées de pagination
    return res.json({
      data: data,
      meta: {
        total: count,
        page: page,
        last_page: Math.ceil(count / limit),
      },
    });
  } catch (err) {
    console.error("Erreur read-daily-reports:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.all("/submit-daily-report", async (req, res) => {
  const { employee_id, summary, needs_restock } = req.body;
  const today = new Date().toISOString().split("T")[0];
  const startDay = `${today}T00:00:00`;
  const endDay = `${today}T23:59:59`;

  let photoUrl = null;

  // A. GESTION DE LA PHOTO DU RAPPORT (Multer)
  if (req.files && req.files.length > 0) {
    const file = req.files.find((f) => f.fieldname === "report_doc");
    if (file) {
      const fileName = `rapport_${employee_id}_${today}_${Date.now()}.${file.originalname.split(".").pop()}`;
      const { error: upErr } = await supabase.storage
        .from("documents")
        .upload(fileName, file.buffer, { contentType: file.mimetype });
      if (!upErr) {
        const { data } = supabase.storage
          .from("documents")
          .getPublicUrl(fileName);
        photoUrl = data.publicUrl;
      }
    }
  }

  try {
    // B. CALCUL AUTOMATIQUE : TEMPS TOTAL ET STATS PRODUITS
    // On récupère toutes les visites que l'agent a faites AUJOURD'HUI
    const { data: visits } = await supabase
      .from("visit_reports")
      .select("duration_minutes, presented_products")
      .eq("employee_id", employee_id)
      .gte("check_in_time", startDay)
      .lte("check_in_time", endDay);

    let totalMinutes = 0;
    const stats = {};

    if (visits && visits.length > 0) {
      visits.forEach((v) => {
        // 1. On additionne les minutes de chaque visite
        totalMinutes += v.duration_minutes || 0;

        // 2. On compte les produits présentés (Logique de comptage)
        let products = v.presented_products;
        if (typeof products === "string") {
          try {
            products = JSON.parse(products);
          } catch (e) {
            products = [];
          }
        }
        if (Array.isArray(products)) {
          products.forEach((p) => {
            let pName = typeof p === "string" ? p : p.name || p.NAME || p.Name;
            if (pName) stats[pName] = (stats[pName] || 0) + 1;
          });
        }
      });
    }

    // C. ENREGISTREMENT EN BASE DE DONNÉES (Table daily_reports)
    // On vérifie si un bilan existe déjà pour aujourd'hui
    const { data: existing } = await supabase
      .from("daily_reports")
      .select("id")
      .eq("employee_id", employee_id)
      .eq("report_date", today)
      .maybeSingle();

    const payload = {
      summary: summary,
      needs_restock: needs_restock === "true",
      products_stats: stats,
      total_work_minutes: totalMinutes, // ✅ SAUVEGARDE DU TEMPS CUMULÉ
      updated_at: new Date(),
    };
    if (photoUrl) payload.photo_url = photoUrl;

    if (existing) {
      // Mise à jour si déjà envoyé
      await supabase
        .from("daily_reports")
        .update(payload)
        .eq("id", existing.id);
    } else {
      // Création si c'est le premier de la journée
      payload.employee_id = employee_id;
      payload.report_date = today;
      await supabase.from("daily_reports").insert([payload]);
    }

    return res.json({ status: "success", total_time: totalMinutes });
  } catch (dbErr) {
    console.error("Erreur serveur bilan journalier:", dbErr);
    return res.status(500).json({ error: dbErr.message });
  }
});

router.all("/delete-visit-report", async (req, res) => {
  const { id } = req.body;
  // On ne supprime pas, on cache pour le manager
  const { error } = await supabase
    .from("visit_reports")
    .update({ hidden_for_manager: true })
    .eq("id", id);
  if (error) throw error;
  return res.json({ status: "success" });
});

router.all("/get-performance-report", async (req, res) => {
  const { start_date, end_date } = req.query;

  // On récupère la synthèse des visites groupées par employé et par lieu
  const { data, error } = await supabase
    .from("visit_reports")
    .select("*, employees(nom, matricule), mobile_locations(name, zone_name)")
    .gte("check_in_time", start_date)
    .lte("check_in_time", end_date);

  if (error) throw error;

  // On transforme les données pour le tableau de bord du Boss
  const stats = {};
  data.forEach((v) => {
    const empId = v.employee_id;
    if (!stats[empId]) {
      stats[empId] = {
        nom: v.employees.nom,
        matricule: v.employees.matricule,
        total_visites: 0,
        lieux: {},
      };
    }
    stats[empId].total_visites++;
    const locName = v.mobile_locations.name;
    stats[empId].lieux[locName] = (stats[empId].lieux[locName] || 0) + 1;
  });

  return res.json(Object.values(stats));
});



router.all("/get-live-positions", async (req, res) => {
    // 1. On ne donne accès qu'aux managers/admin
    if (!checkPerm(req, "can_see_employees")) return res.status(403).json({ error: "Accès refusé" });

    // 2. On récupère le dernier pointage de TOUS les employés actifs
    // Une astuce SQL (DISTINCT ON) pour avoir juste la dernière position de chaque agent
    const { data, error } = await supabase
        .from('pointages')
        .select(`
            id, gps_lat, gps_lon, zone_detectee, action, heure,
            employees(id, nom, poste, photo_url)
        `)
        .order('heure', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    // 3. Filtrer pour n'avoir que le dernier pointage par employé
    const uniqueLocations = [];
    const seen = new Set();
    data.forEach(p => {
        if (!seen.has(p.employee_id) && p.gps_lat && p.gps_lon) {
            uniqueLocations.push(p);
            seen.add(p.employee_id);
        }
    });

    return res.json(uniqueLocations);
});
module.exports = router;
