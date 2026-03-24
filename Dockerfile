# Utilise une version alpine ou "slim" pour des images beaucoup plus légères
FROM node:18-slim

# Installation de LibreOffice (Debian/Slim)
# On ajoute --no-install-recommends pour réduire la taille de l'image
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice \
    && rm -rf /var/lib/apt/lists/*

# Créer le dossier de l'app
WORKDIR /usr/src/app

# Copier uniquement les fichiers nécessaires aux dépendances d'abord
# (Cela permet à Docker de mettre en cache le RUN npm install)
COPY package*.json ./
RUN npm install --production

# Copier le reste du code
COPY . .

# Port exposé
EXPOSE 4000

# Lancer le serveur (on peut utiliser une chaîne de caractères pour plus de compatibilité)
CMD [ "node", "server.js" ]
