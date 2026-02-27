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

// --- CONFIGURATION MULTER (Uploads) ---
const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 }, // Limite 5MB
  fileFilter: (req, file, cb) => {
    // Rend le filtre plus tolérant pour les téléphones
    if (file.mimetype.startsWith("image/") || file.mimetype.includes("pdf") || file.mimetype.includes("document")) {
      cb(null, true);
    } else {
      cb(new Error("Format refusé. Uniquement PDF, DOCX, ou Images."));
    }
  },
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("❌ ERREUR CRITIQUE : JWT_SECRET n'est pas configuré.");
  process.exit(1);
}

// --- MIDDLEWARE DE SÉCURITÉ JWT ---
const authenticateToken = (req, res, next) => {
  const publicPaths =["/login", "/gatekeeper", "/ingest-candidate", "/request-password-reset", "/reset-password"];
  const isPublic = publicPaths.some((path) => req.path.includes(path));
  if (isPublic) return next();

  const authHeader = req.headers["authorization"];
  let token = authHeader && authHeader.split(" ")[1];
  if (!token && req.query.token) token = req.query.token;

  if (!token) return res.status(401).json({ error: "Token manquant" });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: "Session expirée" });
    req.user = { ...decoded, permissions: decoded.permissions || {} };
    next();
  });
};

// Application du middleware de sécurité sur toutes les routes API
app.use("/api", authenticateToken);

// ✅ CORRECTION MAGIQUE : Multer est appelé UNE SEULE FOIS pour toutes les requêtes !
app.use("/api", upload.any());

// --- BRANCHEMENT DES MODULES (ROUTES) ---
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

// ✅ NOUVEAU : GESTIONNAIRE D'ERREURS GLOBAL (Empêche les crash 500 silencieux)
app.use((err, req, res, next) => {
  console.error("❌ ERREUR SERVEUR GLOBALE:", err.message);
  res.status(500).json({ error: err.message || "Erreur interne du serveur." });
});

// Lancement du serveur
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 SERVEUR V2 SUPABASE PRÊT : Port ${PORT}`));require("dotenv").config();
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

// --- CONFIGURATION MULTER (Uploads) ---
const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 }, // Limite 5MB
  fileFilter: (req, file, cb) => {
    // Rend le filtre plus tolérant pour les téléphones
    if (file.mimetype.startsWith("image/") || file.mimetype.includes("pdf") || file.mimetype.includes("document")) {
      cb(null, true);
    } else {
      cb(new Error("Format refusé. Uniquement PDF, DOCX, ou Images."));
    }
  },
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("❌ ERREUR CRITIQUE : JWT_SECRET n'est pas configuré.");
  process.exit(1);
}

// --- MIDDLEWARE DE SÉCURITÉ JWT ---
const authenticateToken = (req, res, next) => {
  const publicPaths =["/login", "/gatekeeper", "/ingest-candidate", "/request-password-reset", "/reset-password"];
  const isPublic = publicPaths.some((path) => req.path.includes(path));
  if (isPublic) return next();

  const authHeader = req.headers["authorization"];
  let token = authHeader && authHeader.split(" ")[1];
  if (!token && req.query.token) token = req.query.token;

  if (!token) return res.status(401).json({ error: "Token manquant" });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: "Session expirée" });
    req.user = { ...decoded, permissions: decoded.permissions || {} };
    next();
  });
};

// Application du middleware de sécurité sur toutes les routes API
app.use("/api", authenticateToken);

// ✅ CORRECTION MAGIQUE : Multer est appelé UNE SEULE FOIS pour toutes les requêtes !
app.use("/api", upload.any());

// --- BRANCHEMENT DES MODULES (ROUTES) ---
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

// ✅ NOUVEAU : GESTIONNAIRE D'ERREURS GLOBAL (Empêche les crash 500 silencieux)
app.use((err, req, res, next) => {
  console.error("❌ ERREUR SERVEUR GLOBALE:", err.message);
  res.status(500).json({ error: err.message || "Erreur interne du serveur." });
});

// Lancement du serveur
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 SERVEUR V2 SUPABASE PRÊT : Port ${PORT}`));
