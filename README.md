# Chesstournament

Web app de gestion de tournois d'échecs, 100 % locale (données dans le `localStorage` du navigateur), sans serveur ni build.

## Fonctionnalités

- **Joueurs** : ajout (Elo par défaut 1000), classement, fiche joueur avec courbe d'Elo et historique, noms modifiables dans Réglages.
- **Elo** : mis à jour à chaque partie (facteur K réglable, 32 par défaut). Il est recalculé à partir de tout l'historique, donc corriger ou effacer un résultat reste cohérent.
- **Tournois** : sélection des participants, puis choix du format :
  - **Poule unique** (toutes rondes),
  - **Poules + phase finale** (répartition en serpentin selon l'Elo, nombre de poules et de qualifiés au choix),
  - **Tableau** à élimination directe (têtes de série selon l'Elo, exempts si le nombre n'est pas une puissance de 2).
  - Options : aller-retour, petite finale.
  - L'app **conseille un format** selon le nombre de participants et affiche le nombre de parties estimé.
- **Saisie des scores** (1-0, ½-½, 0-1) : classement de poule (départage Sonneborn-Berger), avancement du tableau et Elo mis à jour aussitôt. En tableau, une nulle se départage en désignant le vainqueur du départage.
- **Parties libres** hors tournoi, historique complet.
- **Pendule plein écran** : chaque joueur tape sur sa moitié pour passer la main (côté adverse retourné), cadences avec incrément, pause, alerte de fin de temps. Lancée depuis un match de tournoi, elle enregistre directement le résultat.
- **Installable sur téléphone** (PWA) : logo, ouverture en plein écran, fonctionne hors ligne. Android : menu ⋮ → *Installer l'application* (ou bouton dans Réglages). iPhone : Safari → Partager → *Sur l'écran d'accueil*.
- **Export / import JSON** pour sauvegarder ou changer d'appareil.

## Déploiement GitHub Pages

Le workflow `.github/workflows/pages.yml` publie le site à chaque push sur `main`.
Dans *Settings → Pages*, choisir **Source : GitHub Actions**.

## En local

Ouvrir `index.html` dans un navigateur, ou `python3 -m http.server` puis http://localhost:8000.
