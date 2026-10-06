# TD1 — Prise en main (≈ 1 h 15)

**Individuel.** Rendu : `td1/
` dans votre dépôt `docker-td` (un dépôt GitHub **ou** GitLab par personne, formateur invité ; le projet de groupe se fera sur la même plateforme),
avant la **date donnée en cours**. Répondez **avec vos mots**, en citant la commande utilisée et ce que vous avez observé.

> Commandes écrites pour un terminal **bash / zsh** (macOS, Linux, ou Ubuntu dans WSL sous Windows — recommandé).
> Sous PowerShell, remplacez `time <commande>` par `Measure-Command { <commande> }`.

---

## Partie A — Premiers conteneurs

**A1.** Lancez `docker run hello-world`. Relancez-le une seconde fois.
> Qu'est-ce qui diffère entre les deux exécutions, et pourquoi ?

**A2.** Lancez un nginx en arrière-plan, nommé `web1`, accessible sur http://localhost:8080 (image `nginx:1.29-alpine`).
Lancez-en un second, `web2`, accessible sur http://localhost:8081.
> Les deux nginx écoutent sur le port 80 **dans** leur conteneur. Pourquoi n'y a-t-il pas de conflit ?
> Que se passe-t-il si vous essayez de publier `web2` aussi sur 8080 ?

**A3.** Rafraîchissez plusieurs fois http://localhost:8080, puis affichez les logs de `web1`. Suivez-les en continu
pendant que vous rafraîchissez.
> Quelle commande ? D'où viennent ces lignes ?

**A4.** Entrez dans `web1` et remplacez le contenu de `/usr/share/nginx/html/index.html` par votre prénom.
Vérifiez dans le navigateur. Supprimez `web1`, puis relancez-le avec **exactement** la même commande qu'en A2.
> Où est passée votre modification ? Qu'en concluez-vous sur l'usage de `docker exec` pour modifier une application ?

## Partie B — Variables d'environnement et mode interactif

**B1.** Lancez un conteneur `alpine` jetable en lui passant une variable d'environnement `PRENOM` (option `-e`),
et faites-lui afficher cette variable avec la commande `printenv PRENOM`.
Recommencez **sans** l'option `-e`.
> Que s'affiche-t-il dans chaque cas ? La variable `PRENOM` existe-t-elle sur votre machine (`echo $PRENOM`) ?
> Où « vit » une variable passée avec `-e` ?

**B2.** Ouvrez un shell interactif dans un conteneur `alpine` jetable (`--rm`). Installez `curl` (`apk add curl`)
et vérifiez qu'il marche. Quittez, relancez la même commande.
> `curl` est-il encore là ? Pourquoi ? Dans quoi l'installation avait-elle été faite : l'image ou le conteneur ?
> (Comment l'installer durablement : réponse cet après-midi, avec le Dockerfile.)

## Partie C — Images et couches

**C1.** Téléchargez `node:24`, `node:24-slim` et `node:24-alpine`, puis comparez leurs tailles (`docker image ls node`).
Pour comprendre l'écart, regardez ce que contient chacune (remplacez `node:24` par les deux autres) :
```bash
docker run --rm node:24 sh -c 'ls /usr/bin | wc -l'   # nombre de commandes installées
docker run --rm node:24 which gcc git curl            # ces outils sont-ils présents ?
```
> Tableau : taille, nombre de commandes, outils présents. Les trois font tourner le même Node 24 :
> qu'est-ce que la plus grosse contient en plus ? Ces outils sont-ils utiles pour **faire tourner** une API ?

**C2.** Affichez l'historique des couches de `node:24-alpine`.
> Combien de couches ? Quelle instruction a produit la plus lourde ?

**C3.** Une image contient aussi des **métadonnées**. Affichez-les :
```bash
docker image inspect nginx:1.29-alpine
```
Dans ce (long) résultat, retrouvez les champs `Cmd` et `ExposedPorts` (recherche dans le terminal, ou
`docker image inspect nginx:1.29-alpine | grep -A4 Cmd`).
> Quelle commande est lancée au démarrage d'un conteneur nginx ? Quel port est indiqué ?
> Est-ce cohérent avec le port que vous avez utilisé en A2 ?

## Partie D — Énigmes

Pour chaque énigme : **ce que vous observez**, **l'explication**, **la correction**.

**D1.** `docker run -d alpine` rend la main… mais `docker ps` n'affiche rien.
(Indices : `docker ps -a`, et le `Cmd` de l'image `alpine`, comme en C3.)

**D2.** `docker run -d -p 9082:8080 nginx:1.29-alpine` : le conteneur tourne, mais http://localhost:9082 ne répond pas.

**D3.** Chronométrez l'arrêt de ce conteneur, puis regardez son code de sortie :
```bash
docker run -d --name dormeur alpine sleep 1000
time docker stop dormeur
docker ps -a --filter name=dormeur          # colonne STATUS : « Exited (…) »
```
> Combien de temps a pris l'arrêt (selon les machines, de quelques secondes à 10 s) ? Quel code de sortie ? À l'aide de la slide « Cycle de vie », expliquez
> ce que Docker a fait pendant ces secondes. (Pourquoi `sleep` n'a pas réagi : on y reviendra plus tard.)
>
> *Bonus :* recommencez avec `docker run -d --init --name dormeur2 alpine sleep 1000`. Qu'est-ce qui change ?

**D4.** Lancez :
```bash
docker run --name gourmand --memory 50m node:24-alpine \
  node -e "const a=[]; while(true) a.push(new Array(1e6).fill(1))"
```
> Que se passe-t-il ? Quel code de sortie ? Trouvez dans `docker inspect gourmand` le champ qui le confirme.
> Quel mécanisme du noyau vu en cours est à l'œuvre ?

## Partie E — Ménage

**E1.** Combien d'espace Docker occupe-t-il sur votre machine ? Supprimez tous les conteneurs arrêtés de ce TD.
> Commandes utilisées, espace avant / après.

---

### Barème (/10)

| Partie | Points |
|---|---|
| A | 3 |
| B | 1,5 |
| C | 1,5 |
| D | 3,5 |
| E | 0,5 |
