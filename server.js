// ============================================================
//  StockInfirmerie — serveur API (Node + PostgreSQL/Neon)
//  Rôle : pont sécurisé entre l'appli mobile et la base Neon.
//  - Comptes individuels (login + mot de passe HACHÉ bcrypt)
//  - Rôles : "editeur" (modifie) / "lecteur" (consulte)
//  - Les comptes sont créés par un ADMIN (un éditeur)
//
//  Variables d'environnement (à définir dans Render) :
//   - DATABASE_URL : chaîne de connexion Neon (SECRET — jamais dans le code/GitHub)
//   - APP_SECRET   : secret partagé avec l'appli (anti-accès direct)
//   - PORT         : fourni par Render automatiquement
// ============================================================

const http = require("http");
const crypto = require("crypto");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

const DATABASE_URL = process.env.DATABASE_URL || "";
const APP_SECRET = process.env.APP_SECRET || "";
const PORT = parseInt(process.env.PORT || "8080", 10);

if (!DATABASE_URL) console.warn("⚠️  DATABASE_URL manquant — configurez-le dans Render.");

// Pool de connexions PostgreSQL (Neon exige SSL)
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

// ------------------------------------------------------------
//  Sessions en mémoire : token -> { userId, login, role, nom, expire }
//  (simple et suffisant pour une petite équipe ; repart à zéro au redéploiement)
// ------------------------------------------------------------
const sessions = new Map();
const DUREE_SESSION = 1000 * 60 * 60 * 12; // 12 h

function nouveauToken() { return crypto.randomBytes(24).toString("hex"); }
function sessionValide(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expire) { sessions.delete(token); return null; }
  return s;
}

// ------------------------------------------------------------
//  Helpers HTTP
// ------------------------------------------------------------
function envoyer(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Secret, X-Token",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  });
  res.end(body);
}
function lireCorps(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

// Vérifie le secret d'app (toutes les routes sauf la santé)
function secretOk(req) {
  return APP_SECRET && req.headers["x-app-secret"] === APP_SECRET;
}
// Récupère la session depuis l'en-tête X-Token
function utilisateurCourant(req) {
  return sessionValide(req.headers["x-token"] || "");
}

// ============================================================
//  SERVEUR
// ============================================================
const serveur = http.createServer(async (req, res) => {
  // Pré-vol CORS
  if (req.method === "OPTIONS") return envoyer(res, 204, {});

  const url = new URL(req.url, `http://${req.headers.host}`);
  const chemin = url.pathname;
  const methode = req.method;

  try {
    // ---- Santé (publique) ----
    if (chemin === "/" && methode === "GET") {
      let dbOk = false;
      try { await pool.query("SELECT 1"); dbOk = true; } catch {}
      return envoyer(res, 200, { ok: true, service: "StockInfirmerie", base: dbOk ? "connectée" : "injoignable" });
    }

    // ---- À partir d'ici : secret d'app obligatoire ----
    if (!secretOk(req)) return envoyer(res, 401, { erreur: "Accès refusé (secret d'app invalide)." });

    const corps = (methode === "POST" || methode === "PUT") ? await lireCorps(req) : {};

    // ====================  AUTHENTIFICATION  ====================

    // Connexion : { login, motDePasse } -> { token, utilisateur }
    if (chemin === "/login" && methode === "POST") {
      const { login, motDePasse } = corps;
      if (!login || !motDePasse) return envoyer(res, 400, { erreur: "Login et mot de passe requis." });
      const r = await pool.query("SELECT * FROM utilisateurs WHERE login=$1 AND actif=TRUE", [login.trim()]);
      const u = r.rows[0];
      if (!u || !(await bcrypt.compare(motDePasse, u.mot_de_passe)))
        return envoyer(res, 401, { erreur: "Identifiants incorrects." });
      const token = nouveauToken();
      sessions.set(token, { userId: u.id, login: u.login, role: u.role, nom: u.nom, expire: Date.now() + DUREE_SESSION });
      return envoyer(res, 200, { token, utilisateur: { id: u.id, login: u.login, nom: u.nom, role: u.role } });
    }

    // Déconnexion
    if (chemin === "/logout" && methode === "POST") {
      sessions.delete(req.headers["x-token"] || "");
      return envoyer(res, 200, { ok: true });
    }

    // Qui suis-je ? (vérifie que le token est valide)
    if (chemin === "/moi" && methode === "GET") {
      const s = utilisateurCourant(req);
      if (!s) return envoyer(res, 401, { erreur: "Session expirée." });
      return envoyer(res, 200, { utilisateur: { id: s.userId, login: s.login, nom: s.nom, role: s.role } });
    }

    // ---- Toutes les routes suivantes exigent une session valide ----
    const session = utilisateurCourant(req);
    if (!session) return envoyer(res, 401, { erreur: "Connexion requise." });
    const estEditeur = session.role === "editeur";
    // Garde : bloque les écritures pour un lecteur
    const exigeEditeur = () => { if (!estEditeur) { envoyer(res, 403, { erreur: "Réservé aux éditeurs." }); return true; } return false; };

    // ====================  UTILISATEURS (admin = éditeur)  ====================

    if (chemin === "/utilisateurs" && methode === "GET") {
      if (exigeEditeur()) return;
      const r = await pool.query("SELECT id, login, nom, role, actif, cree_le FROM utilisateurs ORDER BY nom");
      return envoyer(res, 200, { utilisateurs: r.rows });
    }
    // Créer un compte : { login, nom, motDePasse, role }
    if (chemin === "/utilisateurs" && methode === "POST") {
      if (exigeEditeur()) return;
      const { login, nom, motDePasse, role } = corps;
      if (!login || !nom || !motDePasse) return envoyer(res, 400, { erreur: "login, nom et mot de passe requis." });
      const roleOk = role === "editeur" ? "editeur" : "lecteur";
      const hash = await bcrypt.hash(motDePasse, 10);
      try {
        const r = await pool.query(
          "INSERT INTO utilisateurs (login, nom, mot_de_passe, role) VALUES ($1,$2,$3,$4) RETURNING id, login, nom, role, actif",
          [login.trim(), nom.trim(), hash, roleOk]);
        return envoyer(res, 200, { utilisateur: r.rows[0] });
      } catch (e) {
        if (/unique/i.test(e.message)) return envoyer(res, 409, { erreur: "Ce login existe déjà." });
        throw e;
      }
    }
    // Modifier/activer/désactiver/changer rôle ou mot de passe : /utilisateurs/:id
    const mUser = chemin.match(/^\/utilisateurs\/(\d+)$/);
    if (mUser && methode === "PUT") {
      if (exigeEditeur()) return;
      const id = parseInt(mUser[1], 10);
      const champs = [], vals = []; let i = 1;
      if (corps.nom != null)   { champs.push(`nom=$${i++}`);  vals.push(corps.nom.trim()); }
      if (corps.role != null)  { champs.push(`role=$${i++}`); vals.push(corps.role === "editeur" ? "editeur" : "lecteur"); }
      if (corps.actif != null) { champs.push(`actif=$${i++}`); vals.push(!!corps.actif); }
      if (corps.motDePasse)    { champs.push(`mot_de_passe=$${i++}`); vals.push(await bcrypt.hash(corps.motDePasse, 10)); }
      if (!champs.length) return envoyer(res, 400, { erreur: "Rien à modifier." });
      vals.push(id);
      const r = await pool.query(`UPDATE utilisateurs SET ${champs.join(", ")} WHERE id=$${i} RETURNING id, login, nom, role, actif`, vals);
      return envoyer(res, 200, { utilisateur: r.rows[0] });
    }

    // ====================  ZONES  ====================

    if (chemin === "/zones" && methode === "GET") {
      const r = await pool.query("SELECT * FROM zones ORDER BY ordre, nom");
      return envoyer(res, 200, { zones: r.rows });
    }
    if (chemin === "/zones" && methode === "POST") {
      if (exigeEditeur()) return;
      const r = await pool.query("INSERT INTO zones (nom, ordre) VALUES ($1,$2) RETURNING *",
        [(corps.nom || "Nouvelle zone").trim(), corps.ordre || 0]);
      return envoyer(res, 200, { zone: r.rows[0] });
    }
    const mZone = chemin.match(/^\/zones\/(\d+)$/);
    if (mZone && methode === "PUT") {
      if (exigeEditeur()) return;
      const r = await pool.query("UPDATE zones SET nom=COALESCE($1,nom), ordre=COALESCE($2,ordre) WHERE id=$3 RETURNING *",
        [corps.nom?.trim() ?? null, corps.ordre ?? null, parseInt(mZone[1], 10)]);
      return envoyer(res, 200, { zone: r.rows[0] });
    }
    if (mZone && methode === "DELETE") {
      if (exigeEditeur()) return;
      await pool.query("DELETE FROM zones WHERE id=$1", [parseInt(mZone[1], 10)]);
      return envoyer(res, 200, { ok: true });
    }

    // ====================  FOURNISSEURS  ====================

    if (chemin === "/fournisseurs" && methode === "GET") {
      const r = await pool.query("SELECT * FROM fournisseurs ORDER BY nom");
      return envoyer(res, 200, { fournisseurs: r.rows });
    }
    if (chemin === "/fournisseurs" && methode === "POST") {
      if (exigeEditeur()) return;
      const c = corps;
      const r = await pool.query(
        "INSERT INTO fournisseurs (nom, email, telephone, site_web, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *",
        [(c.nom || "Fournisseur").trim(), c.email || null, c.telephone || null, c.site_web || null, c.notes || null]);
      return envoyer(res, 200, { fournisseur: r.rows[0] });
    }
    const mFour = chemin.match(/^\/fournisseurs\/(\d+)$/);
    if (mFour && methode === "PUT") {
      if (exigeEditeur()) return;
      const c = corps;
      const r = await pool.query(
        `UPDATE fournisseurs SET nom=COALESCE($1,nom), email=$2, telephone=$3, site_web=$4, notes=$5 WHERE id=$6 RETURNING *`,
        [c.nom?.trim() ?? null, c.email ?? null, c.telephone ?? null, c.site_web ?? null, c.notes ?? null, parseInt(mFour[1], 10)]);
      return envoyer(res, 200, { fournisseur: r.rows[0] });
    }
    if (mFour && methode === "DELETE") {
      if (exigeEditeur()) return;
      await pool.query("DELETE FROM fournisseurs WHERE id=$1", [parseInt(mFour[1], 10)]);
      return envoyer(res, 200, { ok: true });
    }

    // ====================  ARTICLES  ====================

    // Liste complète (avec nom de zone et de fournisseur)
    if (chemin === "/articles" && methode === "GET") {
      const r = await pool.query(`
        SELECT a.*, z.nom AS zone_nom, f.nom AS fournisseur_nom
        FROM articles a
        LEFT JOIN zones z ON z.id = a.zone_id
        LEFT JOIN fournisseurs f ON f.id = a.fournisseur_id
        WHERE a.archive = FALSE
        ORDER BY a.nom`);
      return envoyer(res, 200, { articles: r.rows });
    }
    // Créer un article
    if (chemin === "/articles" && methode === "POST") {
      if (exigeEditeur()) return;
      const c = corps;
      const r = await pool.query(`
        INSERT INTO articles
          (nom, reference, code_barres, zone_id, fournisseur_id, quantite, unite, seuil_bas, qte_commande,
           date_peremption, date_controle, type_controle, essentiel, maj_par)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [ (c.nom || "Article").trim(), c.reference || null, c.code_barres || null, c.zone_id || null, c.fournisseur_id || null,
          c.quantite || 0, c.unite || "pièce", c.seuil_bas || 0, c.qte_commande || 1,
          c.date_peremption || null, c.date_controle || null, c.type_controle || null, !!c.essentiel, session.userId ]);
      const art = r.rows[0];
      await pool.query("INSERT INTO mouvements (article_id, utilisateur_id, type, quantite, quantite_apres) VALUES ($1,$2,'creation',$3,$3)",
        [art.id, session.userId, art.quantite]);
      return envoyer(res, 200, { article: art });
    }
    // Modifier un article
    const mArt = chemin.match(/^\/articles\/(\d+)$/);
    if (mArt && methode === "PUT") {
      if (exigeEditeur()) return;
      const id = parseInt(mArt[1], 10);
      const c = corps;
      const r = await pool.query(`
        UPDATE articles SET
          nom=COALESCE($1,nom), reference=$2, code_barres=$3, zone_id=$4, fournisseur_id=$5,
          quantite=COALESCE($6,quantite), unite=COALESCE($7,unite), seuil_bas=COALESCE($8,seuil_bas),
          qte_commande=COALESCE($9,qte_commande), date_peremption=$10, date_controle=$11,
          type_controle=$12, essentiel=COALESCE($13,essentiel), maj_le=now(), maj_par=$14
        WHERE id=$15 RETURNING *`,
        [ c.nom?.trim() ?? null, c.reference ?? null, c.code_barres ?? null, c.zone_id ?? null, c.fournisseur_id ?? null,
          c.quantite ?? null, c.unite ?? null, c.seuil_bas ?? null, c.qte_commande ?? null,
          c.date_peremption ?? null, c.date_controle ?? null, c.type_controle ?? null, c.essentiel ?? null,
          session.userId, id ]);
      return envoyer(res, 200, { article: r.rows[0] });
    }
    // Ajuster la quantité (+/-) avec traçabilité : { delta, commentaire }
    const mAjust = chemin.match(/^\/articles\/(\d+)\/quantite$/);
    if (mAjust && methode === "POST") {
      if (exigeEditeur()) return;
      const id = parseInt(mAjust[1], 10);
      const delta = Number(corps.delta) || 0;
      const r = await pool.query(
        "UPDATE articles SET quantite = GREATEST(0, quantite + $1), maj_le=now(), maj_par=$2 WHERE id=$3 RETURNING quantite",
        [delta, session.userId, id]);
      if (!r.rows[0]) return envoyer(res, 404, { erreur: "Article introuvable." });
      const apres = r.rows[0].quantite;
      await pool.query("INSERT INTO mouvements (article_id, utilisateur_id, type, quantite, quantite_apres, commentaire) VALUES ($1,$2,$3,$4,$5,$6)",
        [id, session.userId, delta >= 0 ? "entree" : "sortie", delta, apres, corps.commentaire || null]);
      return envoyer(res, 200, { quantite: apres });
    }
    // Archiver (supprimer logiquement)
    if (mArt && methode === "DELETE") {
      if (exigeEditeur()) return;
      await pool.query("UPDATE articles SET archive=TRUE, maj_le=now(), maj_par=$1 WHERE id=$2", [session.userId, parseInt(mArt[1], 10)]);
      return envoyer(res, 200, { ok: true });
    }

    // ====================  VUES D'ANTICIPATION  ====================

    // À commander (stock <= seuil)
    if (chemin === "/alertes/commander" && methode === "GET") {
      const r = await pool.query(`
        SELECT a.*, z.nom AS zone_nom, f.nom AS fournisseur_nom, f.email AS fournisseur_email
        FROM articles a LEFT JOIN zones z ON z.id=a.zone_id LEFT JOIN fournisseurs f ON f.id=a.fournisseur_id
        WHERE a.archive=FALSE AND a.seuil_bas > 0 AND a.quantite <= a.seuil_bas
        ORDER BY f.nom, a.nom`);
      return envoyer(res, 200, { articles: r.rows });
    }
    // Bientôt périmés (dans X jours, défaut 30)
    if (chemin === "/alertes/peremption" && methode === "GET") {
      const jours = parseInt(url.searchParams.get("jours") || "30", 10);
      const r = await pool.query(`
        SELECT a.*, z.nom AS zone_nom FROM articles a LEFT JOIN zones z ON z.id=a.zone_id
        WHERE a.archive=FALSE AND a.date_peremption IS NOT NULL
          AND a.date_peremption <= (CURRENT_DATE + ($1 || ' days')::interval)
        ORDER BY a.date_peremption`, [jours]);
      return envoyer(res, 200, { articles: r.rows });
    }
    // Contrôles à venir (DSA/O2/DASRI) dans X jours
    if (chemin === "/alertes/controle" && methode === "GET") {
      const jours = parseInt(url.searchParams.get("jours") || "30", 10);
      const r = await pool.query(`
        SELECT a.*, z.nom AS zone_nom FROM articles a LEFT JOIN zones z ON z.id=a.zone_id
        WHERE a.archive=FALSE AND a.date_controle IS NOT NULL
          AND a.date_controle <= (CURRENT_DATE + ($1 || ' days')::interval)
        ORDER BY a.date_controle`, [jours]);
      return envoyer(res, 200, { articles: r.rows });
    }

    // Route inconnue
    return envoyer(res, 404, { erreur: "Route inconnue : " + methode + " " + chemin });

  } catch (e) {
    console.error("Erreur serveur:", e.message);
    return envoyer(res, 500, { erreur: "Erreur serveur.", detail: String(e.message).slice(0, 200) });
  }
});

serveur.listen(PORT, () => console.log(`StockInfirmerie API en écoute sur le port ${PORT}`));
