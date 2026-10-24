// ============================================================
//  Création du PREMIER compte administrateur (éditeur)
//  À lancer UNE SEULE FOIS, après avoir configuré DATABASE_URL.
//
//  Utilisation (en local ou via le Shell de Render) :
//    node creer-admin.js <login> "<Nom affiché>" <motDePasse>
//  Exemple :
//    node creer-admin.js alex "Alexandre B." MonMotDePasse123
//
//  Le mot de passe est HACHÉ (bcrypt) avant d'être stocké.
// ============================================================

const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

const [,, login, nom, motDePasse] = process.argv;

if (!login || !nom || !motDePasse) {
  console.error('Usage : node creer-admin.js <login> "<Nom affiché>" <motDePasse>');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquant. Définissez-le avant de lancer ce script.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  try {
    const hash = await bcrypt.hash(motDePasse, 10);
    const r = await pool.query(
      `INSERT INTO utilisateurs (login, nom, mot_de_passe, role, actif)
       VALUES ($1,$2,$3,'editeur',TRUE)
       ON CONFLICT (login) DO UPDATE SET nom=EXCLUDED.nom, mot_de_passe=EXCLUDED.mot_de_passe, role='editeur', actif=TRUE
       RETURNING id, login, nom, role`,
      [login.trim(), nom.trim(), hash]
    );
    console.log("✅ Compte éditeur prêt :", r.rows[0]);
  } catch (e) {
    console.error("❌ Erreur :", e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
