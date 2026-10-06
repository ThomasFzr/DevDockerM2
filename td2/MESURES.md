# TD2 — Mesures et réponses

Stack choisie : **Node 24 + TypeScript + Express** (port 3000).
Machine : macOS (Apple Silicon), Docker Engine 29.4.0.

## Méthode

Chaque version a été mesurée de la même façon :

1. `docker builder prune -af`, pour vider aussi le cache du **contexte**. Sans ça, BuildKit ne renvoie que les
   fichiers modifiés depuis le build précédent, même avec `--no-cache`, et la comparaison de Q3 serait faussée.
2. **Build à froid** : `docker build --no-cache -t td2:vX .`, chronométré. L'image de base est déjà téléchargée
   localement, donc le pull n'est pas compté.
3. **Rebuild** : modification d'une seule ligne de `src/server.ts` (`'Hello Docker'` → `'Hello Docker!'`), puis
   `docker build -t td2:vX .`, chronométré.
4. **Taille** : `docker image ls td2`. Docker 29 affiche la taille sur disque (décompressée) et la taille du contenu
   (compressée, celle qu'on télécharge).
5. **`.env` dans l'image ?** : `docker run --rm td2:vX ls -la`, puis `cat .env`.
6. **Utilisateur** : `docker run --rm td2:vX id`.

Le dossier contenait un `node_modules/` (30 Mo) et un `dist/` produits par un `npm ci && npm run build` local,
comme sur le poste d'un dev.

## Tableau

| Version | Taille de l'image (disque / contenu) | Build à froid | Rebuild après modif d'**une ligne** de code | `.env` dans l'image ? | Utilisateur | Contexte envoyé |
|---|---|---|---|---|---|---|
| **v1** naïve (`node:24`, `COPY . .`) | 1,71 Go / 421 Mo | 4,2 s | 3,2 s (`npm ci` relancé) | **oui** | `root` (uid 0) | 28,8 Mo |
| **v2** cache (`package*.json` d'abord) | 1,71 Go / 421 Mo | 3,5 s | 2,0 s (`npm ci` **CACHED**) | **oui** | `root` (uid 0) | 28,8 Mo |
| **v3** + `.dockerignore` | 1,68 Go / 415 Mo | 4,7 s | 1,3 s | non | `root` (uid 0) | 37 ko |
| **v4** multi-stage, `node:24-alpine`, non-root | **244 Mo / 63 Mo** | 2,7 s | 1,2 s | non | **`node` (uid 1000)** | 37 ko |

**À noter :** l'app n'a qu'une seule dépendance de prod (Express), donc `npm ci` ne prend qu'environ 1,2 s, et les
durées absolues restent faibles. Les temps à froid varient aussi de ± 1 s d'un build à l'autre, à cause du réseau
pendant le téléchargement npm. Ce qui compte surtout, ce sont les étapes **CACHED** au rebuild. Avec une vraie app
(des centaines de dépendances), `npm ci` prend souvent plus d'une minute, et le gain de la v2 devient énorme.

Détail du rebuild v4 (`--progress=plain`) :

```
[build 4/7] RUN npm ci                                  CACHED
[build 5/7] COPY tsconfig.json ./                       CACHED
[build 6/7] COPY src ./src                              DONE 0.1s   ← seule couche invalidée
[build 7/7] RUN npm run build                           DONE 0.6s
[stage-1 4/5] RUN npm ci --omit=dev ...                 CACHED
[stage-1 5/5] COPY --from=build /app/dist ./dist        DONE 0.0s
```

Version intermédiaire **v2/v3** (même Dockerfile, la v3 ajoute seulement le `.dockerignore`) :

```dockerfile
FROM node:24
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

---

## Q1 — Le `.env` est-il dans l'image v1 ?

**Oui.** `COPY . .` copie tout le dossier, `.env` compris :

```bash
docker run --rm td2:v1 cat .env
# API_KEY=sk-live-ne-doit-jamais-finir-dans-une-image
```

**Pourquoi c'est grave, même en local :**

- **Une couche est permanente.** Même si on ajoutait plus tard `RUN rm .env`, le fichier resterait dans la couche
  du `COPY`. N'importe qui ayant l'image peut l'extraire (`docker save`, `docker image history`, `docker cp`).
- **Une image est faite pour circuler.** Elle sera poussée sur un registry, tirée par la CI, déployée sur des
  serveurs, partagée avec des collègues. Chacune de ces étapes copie le secret. On ne contrôle plus qui le voit.
- **Le secret est figé dans un artefact.** Pour faire tourner la clé, il faudrait reconstruire et redéployer
  l'image. Et les anciennes images, encore présentes dans les caches et registries, contiennent toujours l'ancienne
  clé.
- **On le fait sans s'en rendre compte.** Rien n'avertit au build. Le jour où l'image part sur un registry public,
  la clé `sk-live-…` (une clé de **production**) est compromise.

Le secret doit être fourni **à l'exécution** (`-e`, `--env-file`, un gestionnaire de secrets), jamais dans l'image.

## Q2 — Pourquoi le rebuild est-il plus rapide ?

Docker met en cache chaque instruction du Dockerfile. Quand une instruction est invalidée (fichiers copiés
modifiés, commande changée), **toutes les instructions suivantes** sont rejouées.

- **v1** : `COPY . .` copie le code **avant** `npm ci`. Modifier une ligne de `server.ts` invalide ce `COPY`, donc
  `npm ci` est relancé à chaque modification de code.
- **v2** : on copie d'abord **uniquement** `package.json` et `package-lock.json`, on fait `npm ci`, et **ensuite**
  `COPY . .`. Une modification de code n'invalide que le second `COPY` et `npm run build`. La couche `npm ci` reste
  `CACHED`. Rebuild : 3,2 s → 2,0 s. C'est la règle : *ce qui change rarement en haut, ce qui change souvent en bas*.

**Si on modifie `package.json`** (testé en passant `"version"` à `1.0.1`) : le `COPY package.json package-lock.json`
est invalidé, donc `npm ci` est **rejoué** (`DONE 1.2s` au lieu de `CACHED`), ainsi que tout ce qui suit. C'est
voulu : les dépendances ont pu changer, il faut les réinstaller.

## Q3 — `.dockerignore`

```
node_modules   # réinstallé dans l'image par npm ci. Celui de l'hôte est compilé pour macOS (risque de modules
               # natifs incompatibles avec Linux), pèse 30 Mo, et serait de toute façon écrasé.
dist           # artefact de build : il est recompilé dans l'image, la copie locale est inutile (et peut être périmée)
.env           # secret : ne doit JAMAIS finir dans une couche (Q1)
.env.*         # variantes (.env.local, .env.prod…)
!.env.example  # … sauf le modèle, sans vraies valeurs
.git           # historique complet, souvent lourd, inutile à l'exécution
.gitignore     # inutile dans l'image
.DS_Store      # bruit macOS
*.log          # logs locaux
Dockerfile*    # modifier un Dockerfile ne doit pas invalider le cache du COPY . .
.dockerignore  # idem
MESURES.md     # documentation, inutile dans l'image
```

**Ligne `transferring context` :**

| | Contexte envoyé au démon |
|---|---|
| v2 (sans `.dockerignore`) | `transferring context: 28.83MB` |
| v3 (avec `.dockerignore`) | `transferring context: 37.28kB` |

Le contexte est environ **770 fois plus petit**. Avant, tout le dossier était envoyé au démon Docker à chaque build,
y compris les 30 Mo de `node_modules`. Maintenant, seuls `package*.json`, `tsconfig.json` et `src/` partent. Effets
de bord :

- `.env` n'est plus dans l'image (vérifié avec `ls -la`).
- Le rebuild est plus rapide (2,0 s → 1,3 s), parce que `COPY . .` ne recopie plus `node_modules`.
- L'image perd quelques Mo (415 Mo au lieu de 421 Mo de contenu).

## Q4 — Ce qui est dans l'image de build mais plus dans l'image finale

Comparaison entre l'étape `build` (`docker build --target build`, 290 Mo) et l'image finale `td2:v4` (244 Mo) :

| Dans l'étape `build` | Dans l'image finale ? |
|---|---|
| **Le compilateur TypeScript** (`node_modules/typescript`, 22,8 Mo, avec les binaires `tsc` / `tsserver`) | non (`which tsc` → absent) |
| **Les définitions de types** `@types/express`, `@types/node`, `@types/qs`… (10 paquets `@types/*`) | non |
| **Le code source TypeScript** `src/server.ts` | non (`ls src` → *No such file or directory*) |
| **`tsconfig.json`** | non |
| **Toutes les devDependencies** : `node_modules` de 29,7 Mo | seules les deps de prod restent : **3,8 Mo** |
| Le cache npm (`~/.npm`) | non (`npm cache clean --force`) |

L'image finale ne contient que `node:24-alpine`, les dépendances de **prod** (Express et ses sous-dépendances), le
JS compilé `dist/` et `package*.json`.

Par rapport aux versions 1 à 3 (base `node:24` Debian complète), on a aussi retiré de l'image finale **gcc, git, curl**
et tout l'outillage Debian (cf. TD1-C1). D'où le passage de 1,71 Go à 244 Mo (**7 fois plus petit**), et de 421 Mo à
63 Mo téléchargés.

L'application ne tourne plus en root : `USER node` → `uid=1000(node)`. Si l'app était compromise, l'attaquant
n'aurait pas les droits root dans le conteneur.

## Q5 — Une image, plusieurs configurations

```bash
docker run -d --name api-fr -p 3001:3000 -e MESSAGE="Bonjour depuis l'instance FR" -e APP_VERSION=1.0.0 td2:v4
docker run -d --name api-en -p 3002:3000 -e MESSAGE="Hello from the EN instance"   -e APP_VERSION=1.0.0 td2:v4
```

```bash
curl localhost:3001
# {"message":"Bonjour depuis l'instance FR","version":"1.0.0","hostname":"e00222a2b130"}
curl localhost:3002
# {"message":"Hello from the EN instance","version":"1.0.0","hostname":"299702d476ec"}
```

Même image, aucun rebuild : deux comportements différents, et deux `hostname` différents (deux conteneurs).

**Pourquoi ne pas reconstruire pour changer le message :**

- **L'image testée est l'image déployée.** On construit l'image une fois (taguée par exemple avec le SHA du commit),
  on la teste en CI, puis on déploie **exactement cet artefact** en recette et en prod. Reconstruire par
  environnement produirait une image différente de celle qui a été testée : autre résolution de dépendances,
  autre image de base si le tag a bougé… On retomberait sur le « chez moi ça marche ».
- **La configuration n'a rien à faire dans l'image** (12-factor, facteur III). Ce qui change entre dev, recette et
  prod (URL de base, messages, secrets) est fourni par l'environnementà)o à l'exécution. Changer une config devient
  un simple redémarrage, en quelques secondes, sans pipeline de build.
- **Les secrets restent hors de l'image** (cf. Q1). Une image unique peut être partagée sans risque.
- **Traçabilité et rollback.** Une version de code = une image. Revenir en arrière = relancer l'image précédente avec
  la même config.

Bonus : `docker stop api-fr api-en` prend **0,2 s**, avec `Exited (0)`. L'app gère SIGTERM (`server.close()`), et
`node` en PID 1 reçoit bien le signal. Contrairement au `sleep` du TD1, il n'y a pas d'attente de 10 s.
