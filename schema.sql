-- ============================================================
--  StockInfirmerie — schéma de base de données (PostgreSQL / Neon)
--  À coller dans l'éditeur SQL de Neon (SQL Editor) et exécuter.
--  Conçu pour : 89 articles, 6 zones, comptes individuels (éditeur/lecteur),
--  fournisseurs, bons de commande, suivi péremption + contrôle/enlèvement.
-- ============================================================

-- Nettoyage si on recrée tout (à n'utiliser que pour repartir de zéro)
-- DROP TABLE IF EXISTS mouvements, articles, fournisseurs, zones, utilisateurs CASCADE;

-- ------------------------------------------------------------
--  1) UTILISATEURS (comptes individuels + rôle)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS utilisateurs (
  id            SERIAL PRIMARY KEY,
  login         TEXT NOT NULL UNIQUE,          -- identifiant de connexion (ex. "alex")
  nom           TEXT NOT NULL,                 -- nom affiché (ex. "Alexandre B.")
  mot_de_passe  TEXT NOT NULL,                 -- HACHÉ (bcrypt) — jamais en clair
  role          TEXT NOT NULL DEFAULT 'lecteur' -- 'editeur' (modifie) ou 'lecteur' (consulte)
                CHECK (role IN ('editeur','lecteur')),
  actif         BOOLEAN NOT NULL DEFAULT TRUE, -- désactiver un compte sans le supprimer
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
--  2) ZONES (les 6 lieux de rangement : créables/renommables)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zones (
  id       SERIAL PRIMARY KEY,
  nom      TEXT NOT NULL,                      -- ex. "Armoire soins", "Réserve", "Chariot urgence"
  ordre    INT  NOT NULL DEFAULT 0,            -- pour trier l'affichage
  cree_le  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
--  3) FOURNISSEURS (coordonnées pour les bons de commande)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fournisseurs (
  id        SERIAL PRIMARY KEY,
  nom       TEXT NOT NULL,
  email     TEXT,                              -- pour le mail pré-rempli de commande
  telephone TEXT,
  site_web  TEXT,
  notes     TEXT,
  cree_le   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
--  4) ARTICLES (le cœur : les 89 références)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS articles (
  id              SERIAL PRIMARY KEY,
  nom             TEXT NOT NULL,
  reference       TEXT,                        -- réf fournisseur / code interne
  code_barres     TEXT,                        -- pour le scan caméra
  zone_id         INT REFERENCES zones(id) ON DELETE SET NULL,
  fournisseur_id  INT REFERENCES fournisseurs(id) ON DELETE SET NULL,

  quantite        NUMERIC(10,2) NOT NULL DEFAULT 0,
  unite           TEXT NOT NULL DEFAULT 'pièce',
  seuil_bas       NUMERIC(10,2) NOT NULL DEFAULT 0,  -- alerte "bientôt en rupture"
  qte_commande    NUMERIC(10,2) NOT NULL DEFAULT 1,  -- quantité à recommander par défaut

  date_peremption DATE,                        -- "bientôt périmé"
  date_controle   DATE,                        -- contrôle/enlèvement (DSA, O₂, DASRI) — distinct de la péremption
  type_controle   TEXT,                         -- ex. "DSA", "O2", "DASRI" (ou vide)

  photo_url       TEXT,                        -- vignette article (archivage photo plus tard)
  essentiel       BOOLEAN NOT NULL DEFAULT FALSE,
  archive         BOOLEAN NOT NULL DEFAULT FALSE,  -- masquer sans supprimer l'historique

  maj_le          TIMESTAMPTZ NOT NULL DEFAULT now(),
  maj_par         INT REFERENCES utilisateurs(id) ON DELETE SET NULL  -- qui a modifié en dernier
);

-- Index utiles pour les vues d'anticipation (rupture / péremption / contrôle)
CREATE INDEX IF NOT EXISTS idx_articles_zone        ON articles(zone_id);
CREATE INDEX IF NOT EXISTS idx_articles_fournisseur ON articles(fournisseur_id);
CREATE INDEX IF NOT EXISTS idx_articles_peremption  ON articles(date_peremption);
CREATE INDEX IF NOT EXISTS idx_articles_controle    ON articles(date_controle);
CREATE INDEX IF NOT EXISTS idx_articles_codebarres  ON articles(code_barres);

-- ------------------------------------------------------------
--  5) MOUVEMENTS (traçabilité : qui a changé quoi, et quand)
--     Précieux pour du matériel médical.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mouvements (
  id          SERIAL PRIMARY KEY,
  article_id  INT REFERENCES articles(id) ON DELETE CASCADE,
  utilisateur_id INT REFERENCES utilisateurs(id) ON DELETE SET NULL,
  type        TEXT NOT NULL,                   -- 'entree', 'sortie', 'correction', 'creation', 'suppression'
  quantite    NUMERIC(10,2),                   -- variation (+/-)
  quantite_apres NUMERIC(10,2),                -- stock résultant
  commentaire TEXT,
  le          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mouvements_article ON mouvements(article_id);
CREATE INDEX IF NOT EXISTS idx_mouvements_date    ON mouvements(le);

-- ------------------------------------------------------------
--  6) PREMIER COMPTE ADMIN (à personnaliser)
--     Le mot de passe DOIT être haché côté serveur (bcrypt) avant insertion :
--     ne mets jamais un mot de passe en clair ici. Ce compte sera créé
--     proprement par le serveur à la 1re configuration (voir feuille de route).
-- ------------------------------------------------------------
-- (laissé vide volontairement : la création du 1er éditeur se fera via le serveur)

-- ------------------------------------------------------------
--  Données d'exemple pour tester (facultatif, à supprimer ensuite)
-- ------------------------------------------------------------
INSERT INTO zones (nom, ordre) VALUES
  ('Armoire soins', 1),
  ('Réserve', 2),
  ('Chariot urgence', 3),
  ('Frigo médicaments', 4),
  ('Vestiaire secours', 5),
  ('Local DASRI', 6)
ON CONFLICT DO NOTHING;
