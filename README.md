# StockInfirmerie — serveur API

Pont sécurisé entre l'appli mobile et la base de données **Neon** (PostgreSQL).
Gère les comptes (login + mot de passe haché), les rôles **éditeur / lecteur**,
et toutes les données : articles, zones, fournisseurs, mouvements.

> ⚠️ **Secrets** : `DATABASE_URL` et `APP_SECRET` ne doivent JAMAIS être dans le code
> ni sur GitHub. Ils se mettent uniquement dans les **variables d'environnement de Render**.

---

## Architecture

```
Appli (téléphone)  →  Serveur Render (ce dépôt)  →  Base Neon (PostgreSQL)
```

---

## Déploiement sur Render (pas à pas)

1. **Base Neon** : déjà créée, les 5 tables sont en place (via `schema.sql`).
   Récupère ta chaîne de connexion dans Neon (bouton **Connect**) → c'est ton `DATABASE_URL`.

2. **GitHub** : ce dépôt (`stock_infirmerie`) contient le serveur. Pousse tes mises à jour
   depuis GitHub Desktop ; Render redéploie automatiquement.

3. **Render** : https://dashboard.render.com → **New** → **Web Service** →
   connecte ce dépôt GitHub.
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Instance Type** : Free

4. **Variables d'environnement** (onglet *Environment* du service Render) :
   | Clé | Valeur |
   |-----|--------|
   | `DATABASE_URL` | ta chaîne de connexion Neon (secret) |
   | `APP_SECRET` | un mot de passe d'app que tu inventes (le même sera mis dans l'appli) |

5. **Déploie**. Quand c'est en ligne, teste dans le navigateur :
   `https://<ton-service>.onrender.com/` → doit répondre
   `{ "ok": true, "service": "StockInfirmerie", "base": "connectée" }`.
   Si `base: injoignable` → vérifie `DATABASE_URL`.

---

## Créer le premier compte administrateur

Une seule fois, après le déploiement. Deux façons :

**A) Depuis le Shell de Render** (onglet *Shell* du service) :
```
node creer-admin.js alex "Alexandre B." TonMotDePasseSolide
```

**B) En local** (si tu as Node + le `DATABASE_URL` en variable d'environnement) :
```
set DATABASE_URL=postgresql://...        (Windows)
node creer-admin.js alex "Alexandre B." TonMotDePasseSolide
```

Ce compte a le rôle **éditeur** : il pourra ensuite créer les comptes des collègues
depuis l'appli (ou via l'API `/utilisateurs`).

---

## Routes de l'API (résumé)

Toutes les routes (sauf `/`) exigent l'en-tête `X-App-Secret`.
Les routes de données exigent en plus un `X-Token` obtenu via `/login`.

| Méthode | Route | Rôle | Description |
|---------|-------|------|-------------|
| GET  | `/` | public | Santé + état base |
| POST | `/login` | tous | Connexion → renvoie un token |
| POST | `/logout` | tous | Déconnexion |
| GET  | `/moi` | connecté | Infos du compte courant |
| GET/POST/PUT | `/utilisateurs` | éditeur | Gérer les comptes |
| GET  | `/articles` | connecté | Liste des articles |
| POST/PUT/DELETE | `/articles[/:id]` | éditeur | Créer / modifier / archiver |
| POST | `/articles/:id/quantite` | éditeur | Ajuster le stock (+/-) tracé |
| GET/POST/PUT/DELETE | `/zones` | lecture: tous / écriture: éditeur | Zones |
| GET/POST/PUT/DELETE | `/fournisseurs` | lecture: tous / écriture: éditeur | Fournisseurs |
| GET | `/alertes/commander` | connecté | Stock ≤ seuil |
| GET | `/alertes/peremption?jours=30` | connecté | Bientôt périmés |
| GET | `/alertes/controle?jours=30` | connecté | Contrôles à venir (DSA/O₂/DASRI) |

---

## Sécurité

- Mots de passe **hachés** (bcrypt), jamais en clair.
- Les **lecteurs** ne peuvent que consulter ; toute écriture est réservée aux **éditeurs**.
- Chaque modification de stock est **tracée** dans la table `mouvements` (qui, quoi, quand).
- `DATABASE_URL` et `APP_SECRET` restent dans Render, jamais sur GitHub.
