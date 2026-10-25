-- ============================================================
--  StockInfirmerie — schéma de base de données v2 (PostgreSQL / Neon)
--  Calqué sur la structure de l'appli :
--     Lieux → Sous-catégories (optionnelles) → Articles
--     + Fournisseurs (indépendants)
--  Les identifiants sont des textes générés par l'appli
--  (ex. "lieu_lx3k9a2b", "art_lx3k9f7c") : l'appli et la base
--  parlent exactement le même langage.
--
--  Fichier de référence (installation neuve). Pour passer de la v1
--  à la v2 sur la base existante, utiliser migration-v2.sql.
-- ============================================================

-- ------------------------------------------------------------
--  1) UTILISATEURS (comptes individuels + rôle) — inchangé depuis la v1
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS utilisateurs (
  id            SERIAL PRIMARY KEY,
  login         TEXT NOT NULL UNIQUE,
  nom           TEXT NOT NULL,
  mot_de_passe  TEXT NOT NULL,                 -- HACHÉ (bcrypt) — jamais en clair
  role          TEXT NOT NULL DEFAULT 'lecteur'
                CHECK (role IN ('editeur','lecteur')),
  actif         BOOLEAN NOT NULL DEFAULT TRUE,
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
--  2) LIEUX (armoire, réserve, chariot…)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lieux (
  id       TEXT PRIMARY KEY,
  nom      TEXT NOT NULL,
  icone    TEXT NOT NULL DEFAULT 'pin',
  ordre    INT  NOT NULL DEFAULT 0,
  cree_le  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
--  3) SOUS-CATÉGORIES (pochettes à l'intérieur d'un lieu)
--     Supprimer un lieu supprime ses sous-catégories.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sous_categories (
  id       TEXT PRIMARY KEY,
  lieu_id  TEXT NOT NULL REFERENCES lieux(id) ON DELETE CASCADE,
  nom      TEXT NOT NULL,
  couleur  TEXT NOT NULL DEFAULT '#0e7c86',
  cree_le  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_souscat_lieu ON sous_categories(lieu_id);

-- ------------------------------------------------------------
--  4) FOURNISSEURS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fournisseurs (
  id         TEXT PRIMARY KEY,
  nom        TEXT NOT NULL DEFAULT '',
  contact    TEXT NOT NULL DEFAULT '',
  telephone  TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  site       TEXT NOT NULL DEFAULT '',
  cree_le    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
--  5) ARTICLES
--     - Supprimer un lieu supprime ses articles (comme dans l'appli).
--     - Supprimer une sous-catégorie remet ses articles « en vrac » dans le lieu.
--     - Le fournisseur reste un simple nom (comme dans la fiche article).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS articles (
  id               TEXT PRIMARY KEY,
  lieu_id          TEXT NOT NULL REFERENCES lieux(id) ON DELETE CASCADE,
  sous_cat_id      TEXT REFERENCES sous_categories(id) ON DELETE SET NULL,
  designation      TEXT NOT NULL DEFAULT '',
  categorie        TEXT NOT NULL DEFAULT '',
  reference        TEXT NOT NULL DEFAULT '',
  code_barres      TEXT NOT NULL DEFAULT '',
  qte_actuelle     INT  NOT NULL DEFAULT 0,
  qte_minimum      INT  NOT NULL DEFAULT 0,
  qte_commande     INT  NOT NULL DEFAULT 0,
  date_peremption  DATE,
  date_controle    DATE,                        -- contrôle / enlèvement (DSA, O₂, DASRI)
  fournisseur      TEXT NOT NULL DEFAULT '',
  en_commande      BOOLEAN NOT NULL DEFAULT FALSE,
  maj_le           TIMESTAMPTZ NOT NULL DEFAULT now(),
  maj_par          INT REFERENCES utilisateurs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_articles_lieu       ON articles(lieu_id);
CREATE INDEX IF NOT EXISTS idx_articles_souscat    ON articles(sous_cat_id);
CREATE INDEX IF NOT EXISTS idx_articles_codebarres ON articles(code_barres);

-- ------------------------------------------------------------
--  6) MOUVEMENTS (traçabilité : qui a changé quoi, et quand)
--     Pas de lien forcé vers l'article : l'historique survit
--     à la suppression de l'article (on garde sa désignation).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mouvements (
  id              SERIAL PRIMARY KEY,
  article_id      TEXT NOT NULL,
  designation     TEXT,
  utilisateur_id  INT REFERENCES utilisateurs(id) ON DELETE SET NULL,
  type            TEXT NOT NULL,   -- 'creation', 'entree', 'sortie', 'modification', 'suppression', 'import'
  delta           INT,             -- variation de quantité (+/-)
  qte_apres       INT,             -- stock résultant
  le              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mouvements_article ON mouvements(article_id);
CREATE INDEX IF NOT EXISTS idx_mouvements_date    ON mouvements(le);
