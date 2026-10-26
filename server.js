// ============================================================
//  StockInfirmerie — serveur API v2 (Node + PostgreSQL/Neon)
//  Pont sécurisé entre l'appli mobile et la base Neon.
//  Calqué sur l'appli : Lieux → Sous-catégories → Articles + Fournisseurs.
//  Les objets échangés ont EXACTEMENT les mêmes noms de champs que
//  ceux de l'appli (designation, qteActuelle, lieuId, sousCatId…).
//
//  - Comptes individuels (login + mot de passe HACHÉ bcrypt)
//  - Rôles : "editeur" (modifie) / "lecteur" (consulte)
//  - Jetons de connexion SIGNÉS : survivent à la mise en veille et
//    aux redéploiements de Render (pas de déconnexion surprise)
//
//  Variables d'environnement (dans Render) :
//   - DATABASE_URL : chaîne de connexion Neon (SECRET)
//   - APP_SECRET   : secret partagé avec l'appli (anti-accès direct)
//   - TOKEN_SECRET : (facultatif) clé de signature des jetons ;
//                    à défaut, APP_SECRET est utilisé
//   - PORT         : fourni par Render
// ============================================================

const http = require("http");
const crypto = require("crypto");
const { Pool, types } = require("pg");
const bcrypt = require("bcryptjs");

const DATABASE_URL = process.env.DATABASE_URL || "";
const APP_SECRET = process.env.APP_SECRET || "";
const TOKEN_SECRET = process.env.TOKEN_SECRET || APP_SECRET;
const PORT = parseInt(process.env.PORT || "8080", 10);
const DUREE_SESSION = 1000 * 60 * 60 * 24 * 30; // 30 jours

if (!DATABASE_URL) console.warn("⚠️  DATABASE_URL manquant — configurez-le dans Render.");
if (!APP_SECRET) console.warn("⚠️  APP_SECRET manquant — configurez-le dans Render.");

// Les colonnes DATE reviennent en texte "2026-08-15" (comme dans l'appli),
// sinon pg les convertit en Date JS et décale d'un jour selon le fuseau.
types.setTypeParser(1082, (v) => v);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 5,
});

// ------------------------------------------------------------
//  Jetons signés : base64url(json).signature
// ------------------------------------------------------------
function b64(s) { return Buffer.from(s).toString("base64url"); }
function signer(data) { return crypto.createHmac("sha256", TOKEN_SECRET).update(data).digest("base64url"); }
function creerToken(u) {
  const data = b64(JSON.stringify({ id: u.id, exp: Date.now() + DUREE_SESSION }));
  return data + "." + signer(data);
}
function lireToken(token) {
  if (!token || !token.includes(".")) return null;
  const [data, sig] = token.split(".");
  const attendu = signer(data);
  if (sig.length !== attendu.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(attendu))) return null;
  try {
    const p = JSON.parse(Buffer.from(data, "base64url").toString());
    if (!p.exp || Date.now() > p.exp) return null;
    return p;
  } catch { return null; }
}
// Relit le compte en base : un compte désactivé ou un rôle changé
// s'applique immédiatement, même avec un jeton encore valide.
async function utilisateurCourant(req) {
  const p = lireToken(req.headers["x-token"] || "");
  if (!p) return null;
  const r = await pool.query("SELECT id, login, nom, role FROM utilisateurs WHERE id=$1 AND actif=TRUE", [p.id]);
  return r.rows[0] || null;
}

// ------------------------------------------------------------
//  Conversion base (snake_case) ⇄ appli (camelCase)
// ------------------------------------------------------------
const versLieu = (r) => ({ id: r.id, nom: r.nom, icone: r.icone, ordre: r.ordre });
const versSousCat = (r) => ({ id: r.id, lieuId: r.lieu_id, nom: r.nom, couleur: r.couleur });
const versFournisseur = (r) => ({
  id: r.id, nom: r.nom, contact: r.contact, telephone: r.telephone, email: r.email, site: r.site,
});
const versArticle = (r) => ({
  id: r.id, lieuId: r.lieu_id, sousCatId: r.sous_cat_id,
  designation: r.designation, categorie: r.categorie, reference: r.reference, codeBarres: r.code_barres,
  qteActuelle: r.qte_actuelle, qteMinimum: r.qte_minimum, qteCommande: r.qte_commande,
  datePeremption: r.date_peremption, dateControle: r.date_controle,
  fournisseur: r.fournisseur, enCommande: r.en_commande,
  majLe: r.maj_le, majPar: r.maj_par_nom || null,
});

const txt = (v) => (v == null ? "" : String(v).trim());
const ent = (v) => Math.max(0, parseInt(v, 10) || 0);
// Date "AAAA-MM-JJ" valide, sinon null. Répare l'inversion jour/mois
// fréquente à l'import Excel (ex. "2027-20-12" → "2027-12-20").
function date(v) {
  const m = String(v || "").slice(0, 10).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  let [a, mo, j] = [+m[1], +m[2], +m[3]];
  if (mo > 12 && j <= 12) [mo, j] = [j, mo];
  const d = new Date(Date.UTC(a, mo - 1, j));
  if (d.getUTCFullYear() !== a || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== j) return null;
  return `${a}-${String(mo).padStart(2, "0")}-${String(j).padStart(2, "0")}`;
}
const idOk = (v) => typeof v === "string" && /^[A-Za-z0-9_\-]{1,64}$/.test(v);

// ------------------------------------------------------------
//  Requêtes article (partagées entre création unitaire et import)
// ------------------------------------------------------------
const SQL_UPSERT_ARTICLE = `
  INSERT INTO articles
    (id, lieu_id, sous_cat_id, designation, categorie, reference, code_barres,
     qte_actuelle, qte_minimum, qte_commande, date_peremption, date_controle,
     fournisseur, en_commande, maj_le, maj_par)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now(), $15)
  ON CONFLICT (id) DO UPDATE SET
    lieu_id=EXCLUDED.lieu_id, sous_cat_id=EXCLUDED.sous_cat_id,
    designation=EXCLUDED.designation, categorie=EXCLUDED.categorie,
    reference=EXCLUDED.reference, code_barres=EXCLUDED.code_barres,
    qte_actuelle=EXCLUDED.qte_actuelle, qte_minimum=EXCLUDED.qte_minimum,
    qte_commande=EXCLUDED.qte_commande, date_peremption=EXCLUDED.date_peremption,
    date_controle=EXCLUDED.date_controle, fournisseur=EXCLUDED.fournisseur,
    en_commande=EXCLUDED.en_commande, maj_le=now(), maj_par=EXCLUDED.maj_par
  RETURNING *`;
function paramsArticle(a, userId) {
  return [
    a.id, a.lieuId, a.sousCatId || null,
    txt(a.designation), txt(a.categorie), txt(a.reference), txt(a.codeBarres),
    ent(a.qteActuelle), ent(a.qteMinimum), ent(a.qteCommande),
    date(a.datePeremption), date(a.dateControle),
    txt(a.fournisseur), !!a.enCommande, userId,
  ];
}

// ------------------------------------------------------------
//  Helpers HTTP
// ------------------------------------------------------------
function envoyer(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Secret, X-Token",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  });
  res.end(code === 204 ? "" : JSON.stringify(obj));
}
function lireCorps(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}
function secretOk(req) {
  const s = req.headers["x-app-secret"] || "";
  return APP_SECRET && s.length === APP_SECRET.length &&
    crypto.timingSafeEqual(Buffer.from(s), Buffer.from(APP_SECRET));
}

// ============================================================
//  SERVEUR
// ============================================================
const serveur = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return envoyer(res, 204, {});

  const url = new URL(req.url, `http://${req.headers.host}`);
  const chemin = url.pathname.replace(/\/+$/, "") || "/";
  const methode = req.method;

  try {
    // ---- Santé (publique) — sert aussi à « réveiller » Render ----
    if (chemin === "/" && methode === "GET") {
      let dbOk = false;
      try { await pool.query("SELECT 1"); dbOk = true; } catch {}
      return envoyer(res, 200, { ok: true, service: "StockInfirmerie", version: 2, base: dbOk ? "connectée" : "injoignable" });
    }

    if (!secretOk(req)) return envoyer(res, 401, { erreur: "Accès refusé (secret d'app invalide)." });
    const corps = (methode === "POST" || methode === "PUT") ? await lireCorps(req) : {};

    // ====================  AUTHENTIFICATION  ====================

    if (chemin === "/login" && methode === "POST") {
      const login = txt(corps.login).toLowerCase();
      const motDePasse = corps.motDePasse || "";
      if (!login || !motDePasse) return envoyer(res, 400, { erreur: "Identifiant et mot de passe requis." });
      const r = await pool.query("SELECT * FROM utilisateurs WHERE lower(login)=$1 AND actif=TRUE", [login]);
      const u = r.rows[0];
      if (!u || !(await bcrypt.compare(motDePasse, u.mot_de_passe)))
        return envoyer(res, 401, { erreur: "Identifiant ou mot de passe incorrect." });
      return envoyer(res, 200, {
        token: creerToken(u),
        utilisateur: { id: u.id, login: u.login, nom: u.nom, role: u.role },
      });
    }

    // Jeton signé : rien à effacer côté serveur, l'appli oublie le jeton.
    if (chemin === "/logout" && methode === "POST") return envoyer(res, 200, { ok: true });

    // ---- Toutes les routes suivantes exigent une session valide ----
    const moi = await utilisateurCourant(req);
    if (!moi) return envoyer(res, 401, { erreur: "Session expirée, reconnectez-vous." });
    const exigeEditeur = () => {
      if (moi.role === "editeur") return false;
      envoyer(res, 403, { erreur: "Action réservée aux éditeurs." });
      return true;
    };

    if (chemin === "/moi" && methode === "GET") return envoyer(res, 200, { utilisateur: moi });

    // ====================  CHARGEMENT COMPLET  ====================
    // Une seule requête au démarrage de l'appli : tout le stock.
    if (chemin === "/donnees" && methode === "GET") {
      const [l, s, a, f] = await Promise.all([
        pool.query("SELECT * FROM lieux ORDER BY ordre, cree_le"),
        pool.query("SELECT * FROM sous_categories ORDER BY cree_le"),
        pool.query(`SELECT a.*, u.nom AS maj_par_nom FROM articles a
                    LEFT JOIN utilisateurs u ON u.id = a.maj_par ORDER BY a.designation`),
        pool.query("SELECT * FROM fournisseurs ORDER BY nom"),
      ]);
      return envoyer(res, 200, {
        lieux: l.rows.map(versLieu),
        sousCats: s.rows.map(versSousCat),
        articles: a.rows.map(versArticle),
        fournisseurs: f.rows.map(versFournisseur),
      });
    }

    // ====================  UTILISATEURS (éditeur)  ====================

    if (chemin === "/utilisateurs" && methode === "GET") {
      if (exigeEditeur()) return;
      const r = await pool.query("SELECT id, login, nom, role, actif, cree_le FROM utilisateurs ORDER BY nom");
      return envoyer(res, 200, { utilisateurs: r.rows });
    }
    if (chemin === "/utilisateurs" && methode === "POST") {
      if (exigeEditeur()) return;
      const login = txt(corps.login).toLowerCase(), nom = txt(corps.nom), motDePasse = corps.motDePasse || "";
      if (!login || !nom || motDePasse.length < 6)
        return envoyer(res, 400, { erreur: "Identifiant, nom et mot de passe (6 caractères min.) requis." });
      const role = corps.role === "editeur" ? "editeur" : "lecteur";
      try {
        const r = await pool.query(
          "INSERT INTO utilisateurs (login, nom, mot_de_passe, role) VALUES ($1,$2,$3,$4) RETURNING id, login, nom, role, actif",
          [login, nom, await bcrypt.hash(motDePasse, 10), role]);
        return envoyer(res, 200, { utilisateur: r.rows[0] });
      } catch (e) {
        if (/unique/i.test(e.message)) return envoyer(res, 409, { erreur: "Cet identifiant existe déjà." });
        throw e;
      }
    }
    const mUser = chemin.match(/^\/utilisateurs\/(\d+)$/);
    if (mUser && methode === "PUT") {
      if (exigeEditeur()) return;
      const id = parseInt(mUser[1], 10);
      if (id === moi.id && (corps.actif === false || corps.role === "lecteur"))
        return envoyer(res, 400, { erreur: "Vous ne pouvez pas vous retirer vos propres droits." });
      const champs = [], vals = []; let i = 1;
      if (corps.nom != null)   { champs.push(`nom=$${i++}`);   vals.push(txt(corps.nom)); }
      if (corps.role != null)  { champs.push(`role=$${i++}`);  vals.push(corps.role === "editeur" ? "editeur" : "lecteur"); }
      if (corps.actif != null) { champs.push(`actif=$${i++}`); vals.push(!!corps.actif); }
      if (corps.motDePasse)    { champs.push(`mot_de_passe=$${i++}`); vals.push(await bcrypt.hash(corps.motDePasse, 10)); }
      if (!champs.length) return envoyer(res, 400, { erreur: "Rien à modifier." });
      vals.push(id);
      const r = await pool.query(
        `UPDATE utilisateurs SET ${champs.join(", ")} WHERE id=$${i} RETURNING id, login, nom, role, actif`, vals);
      return envoyer(res, 200, { utilisateur: r.rows[0] });
    }

    // ====================  LIEUX  ====================
    // PUT /lieux/:id = créer OU modifier (l'appli fournit l'identifiant)
    const mLieu = chemin.match(/^\/lieux\/([^/]+)$/);
    if (mLieu && methode === "PUT") {
      if (exigeEditeur()) return;
      const id = mLieu[1];
      if (!idOk(id) || !txt(corps.nom)) return envoyer(res, 400, { erreur: "Lieu invalide." });
      const r = await pool.query(`
        INSERT INTO lieux (id, nom, icone, ordre) VALUES ($1,$2,$3,$4)
        ON CONFLICT (id) DO UPDATE SET nom=EXCLUDED.nom, icone=EXCLUDED.icone, ordre=EXCLUDED.ordre
        RETURNING *`, [id, txt(corps.nom), txt(corps.icone) || "pin", parseInt(corps.ordre, 10) || 0]);
      return envoyer(res, 200, { lieu: versLieu(r.rows[0]) });
    }
    if (mLieu && methode === "DELETE") {
      if (exigeEditeur()) return;
      // trace la disparition des articles du lieu avant la suppression en cascade
      await pool.query(`
        INSERT INTO mouvements (article_id, designation, utilisateur_id, type, delta, qte_apres)
        SELECT id, designation, $2, 'suppression', -qte_actuelle, 0 FROM articles WHERE lieu_id=$1`,
        [mLieu[1], moi.id]);
      await pool.query("DELETE FROM lieux WHERE id=$1", [mLieu[1]]);
      return envoyer(res, 200, { ok: true });
    }

    // ====================  SOUS-CATÉGORIES  ====================
    const mSc = chemin.match(/^\/souscats\/([^/]+)$/);
    if (mSc && methode === "PUT") {
      if (exigeEditeur()) return;
      const id = mSc[1];
      if (!idOk(id) || !idOk(corps.lieuId) || !txt(corps.nom)) return envoyer(res, 400, { erreur: "Sous-catégorie invalide." });
      const r = await pool.query(`
        INSERT INTO sous_categories (id, lieu_id, nom, couleur) VALUES ($1,$2,$3,$4)
        ON CONFLICT (id) DO UPDATE SET nom=EXCLUDED.nom, couleur=EXCLUDED.couleur
        RETURNING *`, [id, corps.lieuId, txt(corps.nom), txt(corps.couleur) || "#0e7c86"]);
      return envoyer(res, 200, { sousCat: versSousCat(r.rows[0]) });
    }
    if (mSc && methode === "DELETE") {
      if (exigeEditeur()) return;
      await pool.query("DELETE FROM sous_categories WHERE id=$1", [mSc[1]]); // articles → en vrac (SET NULL)
      return envoyer(res, 200, { ok: true });
    }

    // ====================  ARTICLES  ====================

    // Import en masse (Excel) : { articles: [...] }
    if (chemin === "/articles/import" && methode === "POST") {
      if (exigeEditeur()) return;
      const liste = Array.isArray(corps.articles) ? corps.articles : [];
      if (!liste.length) return envoyer(res, 400, { erreur: "Aucun article à importer." });
      if (liste.some((a) => !idOk(a.id) || !idOk(a.lieuId))) return envoyer(res, 400, { erreur: "Article invalide dans l'import." });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const a of liste) {
          await client.query(SQL_UPSERT_ARTICLE, paramsArticle(a, moi.id));
          await client.query(
            "INSERT INTO mouvements (article_id, designation, utilisateur_id, type, delta, qte_apres) VALUES ($1,$2,$3,'import',$4,$4)",
            [a.id, txt(a.designation), moi.id, ent(a.qteActuelle)]);
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK"); throw e;
      } finally { client.release(); }
      return envoyer(res, 200, { importes: liste.length });
    }

    // PUT /articles/:id = créer OU modifier l'article complet
    const mArt = chemin.match(/^\/articles\/([^/]+)$/);
    if (mArt && methode === "PUT") {
      if (exigeEditeur()) return;
      const a = { ...corps, id: mArt[1] };
      if (!idOk(a.id) || !idOk(a.lieuId)) return envoyer(res, 400, { erreur: "Article invalide." });
      if (a.sousCatId && !idOk(a.sousCatId)) return envoyer(res, 400, { erreur: "Sous-catégorie invalide." });
      const avant = (await pool.query("SELECT qte_actuelle FROM articles WHERE id=$1", [a.id])).rows[0];
      const r = await pool.query(SQL_UPSERT_ARTICLE, paramsArticle(a, moi.id));
      const apres = r.rows[0].qte_actuelle;
      // Traçabilité : création, ou variation de quantité
      if (!avant || avant.qte_actuelle !== apres) {
        const delta = avant ? apres - avant.qte_actuelle : apres;
        const type = !avant ? "creation" : delta > 0 ? "entree" : "sortie";
        await pool.query(
          "INSERT INTO mouvements (article_id, designation, utilisateur_id, type, delta, qte_apres) VALUES ($1,$2,$3,$4,$5,$6)",
          [a.id, r.rows[0].designation, moi.id, type, delta, apres]);
      }
      return envoyer(res, 200, { article: versArticle({ ...r.rows[0], maj_par_nom: moi.nom }) });
    }
    if (mArt && methode === "DELETE") {
      if (exigeEditeur()) return;
      const r = await pool.query("DELETE FROM articles WHERE id=$1 RETURNING designation, qte_actuelle", [mArt[1]]);
      if (r.rows[0]) await pool.query(
        "INSERT INTO mouvements (article_id, designation, utilisateur_id, type, delta, qte_apres) VALUES ($1,$2,$3,'suppression',$4,0)",
        [mArt[1], r.rows[0].designation, moi.id, -r.rows[0].qte_actuelle]);
      return envoyer(res, 200, { ok: true });
    }

    // Historique d'un article (pour plus tard : « qui a modifié ? »)
    const mHist = chemin.match(/^\/articles\/([^/]+)\/historique$/);
    if (mHist && methode === "GET") {
      const r = await pool.query(`
        SELECT m.type, m.delta, m.qte_apres, m.le, u.nom AS par FROM mouvements m
        LEFT JOIN utilisateurs u ON u.id = m.utilisateur_id
        WHERE m.article_id=$1 ORDER BY m.le DESC LIMIT 100`, [mHist[1]]);
      return envoyer(res, 200, { historique: r.rows });
    }

    // ====================  FOURNISSEURS  ====================
    const mFour = chemin.match(/^\/fournisseurs\/([^/]+)$/);
    if (mFour && methode === "PUT") {
      if (exigeEditeur()) return;
      const id = mFour[1];
      if (!idOk(id)) return envoyer(res, 400, { erreur: "Fournisseur invalide." });
      const c = corps;
      const r = await pool.query(`
        INSERT INTO fournisseurs (id, nom, contact, telephone, email, site) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (id) DO UPDATE SET nom=EXCLUDED.nom, contact=EXCLUDED.contact,
          telephone=EXCLUDED.telephone, email=EXCLUDED.email, site=EXCLUDED.site
        RETURNING *`, [id, txt(c.nom), txt(c.contact), txt(c.telephone), txt(c.email), txt(c.site)]);
      return envoyer(res, 200, { fournisseur: versFournisseur(r.rows[0]) });
    }
    if (mFour && methode === "DELETE") {
      if (exigeEditeur()) return;
      await pool.query("DELETE FROM fournisseurs WHERE id=$1", [mFour[1]]);
      return envoyer(res, 200, { ok: true });
    }

    // ====================  TOUT EFFACER (lieux + articles)  ====================
    // Exige { confirmation: "EFFACER" } pour éviter un accident.
    if (chemin === "/tout" && methode === "DELETE") {
      if (exigeEditeur()) return;
      if (url.searchParams.get("confirmation") !== "EFFACER")
        return envoyer(res, 400, { erreur: "Confirmation manquante." });
      await pool.query(`
        INSERT INTO mouvements (article_id, designation, utilisateur_id, type, delta, qte_apres)
        SELECT id, designation, $1, 'suppression', -qte_actuelle, 0 FROM articles`, [moi.id]);
      await pool.query("DELETE FROM lieux"); // cascade : sous-catégories + articles
      return envoyer(res, 200, { ok: true });
    }

    return envoyer(res, 404, { erreur: "Route inconnue : " + methode + " " + chemin });

  } catch (e) {
    console.error("Erreur serveur:", e.message);
    // Référence inexistante (lieu supprimé entre-temps…) → message clair
    if (e.code === "23503") return envoyer(res, 409, { erreur: "Élément lié introuvable (supprimé par un collègue ?). Rafraîchissez." });
    return envoyer(res, 500, { erreur: "Erreur serveur.", detail: String(e.message).slice(0, 200) });
  }
});

serveur.listen(PORT, () => console.log(`StockInfirmerie API v2 en écoute sur le port ${PORT}`));
