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
const systemRoutes = require("./routes/system"); // ✅ Ajouté

const app = express();

// --- CONFIGURATION MULTER (Uploads) ---
const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 }, // Limite 5MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
      "application/pdf",
      "image/jpeg",
      "image/png",
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Format refusé. Uniquement PDF, DOCX, JPG, PNG."));
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
  // Liste des routes publiques (qui ne nécessitent pas de token)
  // On vérifie si l'URL contient ces mots-clés
  const publicPaths = [
    "/login",
    "/gatekeeper",
    "/ingest-candidate",
    "/request-password-reset",
    "/reset-password",
  ];

  // Si l'URL actuelle correspond à une route publique, on laisse passer
  const isPublic = publicPaths.some((path) => req.path.includes(path));
  if (isPublic) return next();

  // Sinon, on vérifie le token
  const authHeader = req.headers["authorization"];
  let token = authHeader && authHeader.split(" ")[1];
  if (!token && req.query.token) token = req.query.token;

  if (!token) {
    return res.status(401).json({ error: "Token manquant" });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: "Session expirée" });

    // On attache les infos utilisateur à la requête
    req.user = {
      ...decoded,
      permissions: decoded.permissions || {},
    };
    next();
  });
};

// Application du middleware de sécurité sur toutes les routes API
app.use("/api", authenticateToken);

// --- BRANCHEMENT DES MODULES (ROUTES) ---
app.use("/api", upload.any(), authRoutes);
app.use("/api", upload.any(), employeeRoutes);
app.use("/api", upload.any(), payrollRoutes);
app.use("/api", upload.any(), leavesRoutes);
app.use("/api", upload.any(), contractsRoutes);
app.use("/api", upload.any(), recruitmentRoutes);
app.use("/api", upload.any(), mobileRoutes);
app.use("/api", upload.any(), catalogRoutes);
app.use("/api", upload.any(), chatRoutes);
app.use("/api", upload.any(), systemRoutes);

// Lancement du serveur
const PORT = process.env.PORT || 4000;
app.listen(PORT, () =>
  console.log(`🚀 SERVEUR V2 SUPABASE PRÊT : Port ${PORT}`),
);
