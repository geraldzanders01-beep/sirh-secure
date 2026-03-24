const axios = require("axios");
const supabase = require("./supabaseClient");
const webpush = require('web-push');
const Jimp = require('jimp');



// Fonction pour calculer la date de fin (Date début + nombre de jours)
const getEndDate = (startDate, days) => {
  if (!startDate || !days) return null;
  const date = new Date(startDate);
  date.setDate(date.getDate() + parseInt(days));
  return date.toISOString().split("T")[0]; // Renvoie format YYYY-MM-DD
};

async function isTargetAuthorized(requester, targetId) {
  // 1. Si le demandeur est ADMIN ou RH, il a tous les droits
  if (requester.permissions?.can_see_employees) return true;

  // 2. Si c'est l'utilisateur lui-même qui agit sur son propre compte
  if (String(requester.emp_id) === String(targetId)) return true;

  // 3. Sinon, on vérifie dans la base de données
  const { data: target } = await supabase
    .from("employees")
    .select("id, hierarchy_path, departement")
    .eq("id", targetId)
    .maybeSingle();

  if (!target) return false;

  // A. Est-ce que la cible est dans ma lignée descendante ?
  const isUnderMe = target.hierarchy_path?.startsWith(
    requester.hierarchy_path + "/",
  );

  // B. Est-ce que la cible est dans mon Scope (Département) ?
  const isInMyScope = requester.management_scope?.includes(target.departement);

  return isUnderMe || isInMyScope;
}

// Fonction pour vérifier une permission spécifique
function checkPerm(req, permissionName) {
  return (
    req.user &&
    req.user.permissions &&
    req.user.permissions[permissionName] === true
  );
}



  function calculateAutoClose(startMs, isSecurity) {
            const startDate = new Date(startMs);
            if (isSecurity) {
                // Pour la sécurité/nuit : Forfait de 12 heures de garde
                return startMs + (12 * 60 * 60 * 1000);
            } else {
                // Pour bureau/mobile : Clôture à 18h00 le jour même
                const eighteenHour = new Date(startDate);
                eighteenHour.setHours(18, 0, 0, 0);
                
                // Si l'entrée était déjà après 18h, on accorde 1h symbolique, sinon 18h
                return (startDate.getTime() >= eighteenHour.getTime()) 
                    ? startDate.getTime() + (60 * 60 * 1000) 
                    : eighteenHour.getTime();
            }
        }  






// Fonction utilitaire pour calculer la distance (Formule de Haversine)
function getDistanceInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Rayon de la terre en mètres
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function sendEmailAPI(toEmail, subject, htmlContent) {
  try {
    await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: { name: "SIRH SECURE", email: "nevillebouchard98@gmail.com" },
        to: [{ email: toEmail }],
        subject: subject,
        htmlContent: htmlContent,
      },
      {
        headers: {
          "api-key": (process.env.BREVO_API_KEY || "").trim(),
          "Content-Type": "application/json",
        },
      },
    );
    console.log(`✅ Mail envoyé avec succès à ${toEmail}`);
    return true;
  } catch (error) {
    console.error(
      "❌ Échec envoi API Brevo:",
      error.response ? error.response.data : error.message,
    );
    return false;
  }
}

// Fonction pour vérifier si un module est actif
async function isModuleActive(moduleKey) {
  const { data } = await supabase
    .from("company_modules")
    .select("is_active")
    .eq("module_key", moduleKey)
    .single();
  return data ? data.is_active : false; // Par défaut false si pas trouvé
}



/**
 * Envoie une notification Push à un utilisateur spécifique
 */
async function sendPushNotification(userId, title, body, url = '/') {
    // 1. Récupérer tous les abonnements (téléphones/PC) de cet utilisateur
    const { data: subs, error } = await supabase
        .from('push_subscriptions')
        .select('*')
        .eq('user_id', userId);

    if (error || !subs || subs.length === 0) return;

    // 2. Créer le message
    const payload = JSON.stringify({ title, body, url });

    // 3. Envoyer à chaque appareil enregistré
    const tasks = subs.map(sub => {
        const pushConfig = {
            endpoint: sub.endpoint,
            keys: { auth: sub.auth, p256dh: sub.p256dh }
        };

        return webpush.sendNotification(pushConfig, payload).catch(err => {
            // Si le token n'est plus valide (app désinstallée), on nettoie la base
            if (err.statusCode === 410 || err.statusCode === 404) {
                return supabase.from('push_subscriptions').delete().eq('id', sub.id);
            }
            console.error("Erreur d'envoi Push :", err);
        });
    });

    await Promise.all(tasks);
}




async function addWatermark(buffer, gps, nomAgent) {
    try {
        const image = await Jimp.read(buffer);
        const font = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE); // Petite police blanche
        
        const width = image.bitmap.width;
        const height = image.bitmap.height;
        const dateStr = new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Porto-Novo' });
        const text = `SIRH SECURE | ${nomAgent} | GPS: ${gps} | ${dateStr}`;

        // 1. Dessiner un bandeau noir semi-transparent en bas pour la lisibilité
        const bannerHeight = 40;
        new Jimp(width, bannerHeight, '#000000cc', (err, banner) => {
            image.composite(banner, 0, height - bannerHeight);
        });

        // 2. Écrire le texte sur le bandeau
        image.print(font, 15, height - 30, text);

        return await image.getBufferAsync(Jimp.MIME_JPEG);
    } catch (e) {
        console.error("Erreur Watermark:", e);
        return buffer; // En cas d'erreur, on rend l'image originale pour ne pas bloquer l'agent
    }
}

module.exports = {
  getEndDate,
  isTargetAuthorized,
  checkPerm,
  getDistanceInMeters,
  sendEmailAPI,
  isModuleActive,
  sendPushNotification,
  calculateAutoClose,
  addWatermark
};
