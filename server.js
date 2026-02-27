require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const jwt = require("jsonwebtoken");

// --- IMPORTS DES MODULES ---
const authRoutes = require("./routes/auth");
const employeeRoutes = require("./routes/employees");
const payrollRoutes = require("./routes/payroll");
const leavesRoutes = require("./routes/leaves");
const contractsRoutes = require("./routes/contracts");
const recruitmentRoutes = require("./routes/recruitment");
const mobileRoutes = require("./routes/mobile");
const catalogRoutes = require("./routes/catalog");
const chatRoutes = require("./routes/chat");
const systemRoutes = require("./routes/system"); 

const app = express();

// --- CONFIGURATION MULTER (Uploads en mémoire pour plus de rapidité) ---
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // Augmenté à 10MB pour les photos HD
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp"
    ];
    if (allowedMimeTypes.includes(file.mimetype) || file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error(`Format ${file.mimetype} refusé.`));
    }
  },
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("❌ ERREUR CRITIQUE : JWT_SECRET n'est pas configuré dans les variables d'environnement.");
  process.exit(1);
}

// --- MIDDLEWARE DE SÉCURITÉ JWT ---
const authenticateToken = (req, res, next) => {
  const publicPaths = [
    "/login",
    "/gatekeeper",
    "/ingest-candidate",
    "/request-password-reset",
    "/reset-password",
  ];

  const isPublic = publicPaths.some((path) => req.path.includes(path));
  if (isPublic) return next();

  const authHeader = req.headers["authorization"];
  let token = authHeader && authHeader.split(" ")[1];
  if (!token && req.query.token) token = req.query.token;

  if (!token) {
    return res.status(401).json({ error: "Token de sécurité manquant" });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: "Session expirée ou invalide" });
    req.user = {
      ...decoded,
      permissions: decoded.permissions || {},
    };
    next();
  });
};

// 1. D'abord on vérifie la sécurité
app.use("/api", authenticateToken);

// 2. Ensuite on traite les fichiers (UNE SEULE FOIS pour toutes les routes en dessous)
app.use("/api", upload.any());

// 3. Enfin on dirige vers les fichiers de routes
app.use("/api", authRoutes);
app.use("/api", employeeRoutes);
app.use("/api", payrollRoutes);
app.use("/api", leavesRoutes);
app.use("/api", contractsRoutes);
app.use("/api", recruitmentRoutes);
app.use("/api", mobileRoutes);
app.use("/api", catalogRoutes);
app.use("/api", chatRoutes);
app.use("/api", systemRoutes);

// --- GESTIONNAIRE D'ERREURS GLOBAL (Anti-Crash) ---
app.use((err, req, res, next) => {
  console.error("🚨 ERREUR SERVEUR :", err.message);
  res.status(err.status || 500).json({
    status: "error",
    error: err.message || "Une erreur interne est survenue sur le serveur."
  });
});

// Lancement du serveur
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`
  🚀  SERVEUR SIRH-SECURE OPÉRATIONNEL
  -----------------------------------
  🌍  Port : ${PORT}
  🔐  JWT Secret : Configuré ✅
  -----------------------------------
  `);
});
