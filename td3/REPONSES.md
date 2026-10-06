# TD3 — Réponses B et C

Compose v5.1.2, Docker Engine 29.4.0. Projet `td3`, donc les conteneurs s'appellent `td3-api-1`, `td3-db-1` et
`td3-cache-1`.

## B1 — `compose.yaml` et `.env`

Aucun secret dans `compose.yaml` : les valeurs viennent de `.env` (ignoré par git), dont le modèle `.env.example`
est commité.

```bash
cp .env.example .env     # puis choisir un vrai mot de passe
docker compose config
```

Extrait de l'interpolation :

```yaml
  api:
    environment:
      DB_HOST: db
      DB_NAME: visites
      DB_PASSWORD: s3cr3t-local
      DB_USER: visites
      REDIS_URL: redis://cache:6379
  db:
    environment:
      POSTGRES_DB: visites
      POSTGRES_PASSWORD: s3cr3t-local
      POSTGRES_USER: visites
networks:
  default:
    name: td3_default        # réseau créé automatiquement : DNS par nom de service
volumes:
  pgdata:
    name: td3_pgdata
```

## B2 — Le premier démarrage

Premier `up` sur un volume vide, **sans** `restart:` :

```bash
docker compose up -d --build
docker compose ps -a
# api     Exited (1) 5 seconds ago
# cache   Up 6 seconds
# db      Up 6 seconds
docker compose logs api
# Connecting to Postgres at db:5432…
# Error: connect ECONNREFUSED 192.168.97.2:5432
```

**L'erreur :** `ECONNREFUSED`. Le nom `db` est bien résolu (`192.168.97.2`), donc le réseau fonctionne, mais
**personne n'écoute encore** sur le port 5432. Au premier démarrage, Postgres initialise la base. Les logs le montrent :
il démarre un serveur temporaire, crée la base, l'arrête, puis redémarre pour de bon.

```bash
docker inspect td3-api-1 --format '{{.State.StartedAt}} {{.State.FinishedAt}}'
# 12:26:28.951  →  12:26:29.190   (l'API a planté au bout de 0,24 s)
docker compose logs db | grep -E 'init process complete|ready to accept'
# 12:26:29.884  PostgreSQL init process complete; ready for start up.
# 12:26:30.104  LOG:  database system is ready to accept connections
```

L'API a abandonné à 12:26:29.19, alors que Postgres n'a été prêt qu'à 12:26:30.10, environ 1 s trop tard.

**`depends_on` ne suffisait pas ?** Non. `depends_on: [db]` garantit seulement l'**ordre de démarrage** : Compose
lance le conteneur `db` avant `api` (`condition: service_started` dans `docker compose config`). Il attend que le
**conteneur** soit démarré, pas que **Postgres** soit prêt à accepter des connexions. L'app, elle, tente une seule
connexion au démarrage et quitte en erreur si elle échoue.

**Avec `restart: on-failure`** (après `docker compose down -v`, pour repartir d'un volume vide) :

```bash
docker compose up -d
docker inspect td3-api-1 --format '{{.RestartCount}}'      # 3
docker compose logs api | grep -E 'ECONNREFUSED|listening'
# Error: connect ECONNREFUSED 192.168.97.3:5432
# Error: connect ECONNREFUSED 192.168.97.3:5432
# Error: connect ECONNREFUSED 192.168.97.3:5432
# Visites API listening on 3000
curl localhost:3000
# {"hitsInRedis":1,"visitsInPostgres":1,"servedBy":"d66144b86d50"}
```

Docker relance l'API à chaque sortie en erreur. Elle plante 3 fois, puis le 4ᵉ essai tombe sur un Postgres prêt et
démarre.

**Pourquoi c'est un contournement :**

- On ne **sait pas** quand le service est prêt, on **réessaie au hasard** jusqu'à ce que ça passe. Pendant ce temps,
  l'API est en boucle de crash : des logs d'erreur trompeurs, un service indisponible, une alerte potentielle en
  production.
- `on-failure` relance **tout** plantage, pas seulement « la base n'est pas encore prête ». Un vrai bug (mauvais mot
  de passe, base absente) donne la même boucle infinie, et masque la vraie cause.
- Si la base met longtemps (gros volume, restauration), le délai entre les redémarrages augmente et l'API attend sans
  raison.

La vraie solution est de dire à Compose **quand** la base est prête (un `healthcheck` sur `db`, par exemple avec
`pg_isready`, et `depends_on: condition: service_healthy`), et/ou de faire réessayer la connexion par l'app.

**Le contournement ne marche même pas en dev.** En testant l'environnement de dev (partie C) depuis un volume vide,
l'API plante au premier démarrage, mais ne redémarre jamais :

```bash
docker compose down -v && docker compose up -d --build
docker compose logs api | tail -1
# Failed running 'src/server.js'. Waiting for file changes before restarting...
docker inspect td3-api-1 --format '{{.RestartCount}}'     # 0
```

En dev, le processus principal est `node --watch`. C'est lui qui attrape le plantage de l'app et attend une
modification de fichier. Le conteneur ne s'arrête donc pas, et `restart: on-failure` ne se déclenche jamais :
l'API reste bloquée.

J'ai donc ajouté la vraie solution dans le `compose.yaml` rendu (j'ai gardé `restart: on-failure`, comme demandé) :

```yaml
  api:
    depends_on:
      db:
        condition: service_healthy
  db:
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"]
      interval: 2s
      timeout: 3s
      retries: 15
```

Le `$$` empêche Compose d'interpoler la variable : c'est le shell du conteneur `db` qui lira `$POSTGRES_USER`.
Résultat, en dev comme en prod, depuis un volume vide :

```bash
docker compose up -d --build
#  Container td3-db-1 Waiting
#  Container td3-db-1 Healthy        ← Compose attend que pg_isready réponde
#  Container td3-api-1 Started
curl localhost:3000
# {"hitsInRedis":1,"visitsInPostgres":1,"servedBy":"1ff906c312a5"}
# RestartCount=0, aucune erreur ECONNREFUSED dans les logs
```

## B3 — Persistance des données

**1. Les données survivent à `down` puis `up` :**

```bash
curl localhost:3000   # … "visitsInPostgres":5 …
docker compose down
#  Container td3-api-1 Removed
#  Container td3-cache-1 Removed
#  Container td3-db-1 Removed
#  Network td3_default Removed
docker volume ls --filter name=td3
# local     td3_pgdata              ← le volume est toujours là
docker compose up -d
curl localhost:3000
# {"hitsInRedis":1,"visitsInPostgres":6,"servedBy":"6b17283cc28f"}
```

Postgres reprend à **6** : les conteneurs et le réseau ont été supprimés, mais pas le volume `td3_pgdata`.

**2. Elles disparaissent avec `down -v` :**

```bash
docker compose down -v
#  Volume td3_pgdata Removed
docker volume ls --filter name=td3
# (vide)
docker compose up -d
curl localhost:3000
# {"hitsInRedis":1,"visitsInPostgres":1,"servedBy":"fe357f070ddc"}
```

Postgres repart à **1** : `-v` supprime les volumes déclarés dans le fichier, et la base est réinitialisée.

**Et Redis ?** Il était reparti à 1 dans **les deux** cas, même après un simple `down`. Redis écrit ses données
dans `/data` :

```bash
docker compose exec cache redis-cli CONFIG GET dir     # /data
docker compose exec cache redis-cli CONFIG GET save    # 3600 1 300 100 60 10000
```

Il sauvegarde bien sur disque (snapshot RDB, et à l'arrêt), mais `/data` n'était monté sur aucun volume nommé. À
chaque `down`, ces données partent avec le conteneur.

**Il faut ajouter un volume nommé sur `/data`** (fait dans le `compose.yaml` rendu) :

```yaml
  cache:
    image: redis:8-alpine
    volumes:
      - redisdata:/data
volumes:
  pgdata:
  redisdata:
```

Vérification :

```bash
curl localhost:3000                  # … "hitsInRedis":3 …
docker compose down && docker compose up -d
curl localhost:3000
# {"hitsInRedis":4,"visitsInPostgres":4,"servedBy":"0bd68822f0bb"}
docker compose logs cache | grep RDB
# Done loading RDB, keys loaded: 1, keys expired: 0.
```

## B4 — Les adresses IP

```bash
docker compose exec api getent hosts db
# 192.168.97.3      db  db
docker compose up -d --force-recreate db
docker compose exec api getent hosts db
# 192.168.97.3      db  db
```

Avec un simple `--force-recreate`, l'IP **n'a pas changé** : `db` a été supprimé puis recréé aussitôt, et Docker lui
a redonné l'adresse qui venait de se libérer. Mais rien ne le garantit. En recréant tout le projet plusieurs fois,
l'IP de `db` change selon l'ordre dans lequel les conteneurs obtiennent leur adresse :

```bash
docker compose down && docker compose up -d
docker compose exec api getent hosts db cache
# up #1 : db=192.168.97.2  cache=192.168.97.3
# up #2 : db=192.168.97.2  cache=192.168.97.3
# up #3 : db=192.168.97.3  cache=192.168.97.2   ← db et cache ont échangé leurs IP
# up #4 : db=192.168.97.2  cache=192.168.97.3
```

C'est aussi visible dans les logs de B2 : `ECONNREFUSED 192.168.97.2` au premier `up`, puis `192.168.97.3` au
suivant.

**Pourquoi ne jamais écrire une IP de conteneur dans une config :** l'IP est attribuée **dynamiquement** à chaque
création du conteneur, selon les adresses libres du réseau. Un conteneur est jetable : il est recréé à chaque mise
à jour d'image, crash, `down`/`up` ou changement de config, et son IP peut alors changer. Une config avec
`DB_HOST=192.168.97.2` marcherait par hasard, puis l'API se connecterait un jour au **mauvais service**
(ici, à Redis), ou à rien. Le **nom du service** (`db`), lui, est stable : le DNS de Docker le résout toujours vers
l'IP actuelle.

## C1 — `compose.override.yaml` (dev)

`compose.override.yaml` est fusionné automatiquement avec `compose.yaml` par `docker compose up` :

- `build.target: dev` : l'image dev (toutes les dépendances, `npm run dev`, donc `node --watch`) ;
- `develop.watch` : `./app/src` est synchronisé dans `/app/src`, et `./app/package.json` déclenche un `rebuild` ;
- `db.ports: "${DB_HOST_PORT:-5432}:5432"` : la base est joignable depuis la machine, sur un port configurable dans
  `.env` (5432 par défaut).

```bash
docker compose up -d --build
docker compose ps
# api     Up   0.0.0.0:3000->3000/tcp
# db      Up   0.0.0.0:5432->5432/tcp      ← publié en dev seulement
docker compose exec api ps -o args
# npm run dev
# node --watch src/server.js
pg_isready -h localhost -p 5432
# localhost:5432 - accepting connections   ← un client SQL peut s'y connecter
docker compose watch
```

**Le piège rencontré.** J'ai d'abord utilisé `action: sync`, comme dans le cours. La **première** modification de
`/health` a été prise en compte (`Restarting 'src/server.js'`), mais **pas les suivantes**. Pourtant, Compose
synchronisait bien le fichier :

```bash
docker compose exec api grep -n health src/server.js
# 46: … res.json({ status: 'UP', mode: 'dev', watch: true }) …     ← le fichier est à jour
curl localhost:3000/health
# {"status":"UP","mode":"dev"}                                    ← l'ancienne version tourne encore
docker compose exec api ls -i src/server.js     # 229717 src/server.js
# (modification + sync)
docker compose exec api ls -i src/server.js     # 229723 src/server.js   ← nouvel inode
```

La synchronisation **remplace** le fichier (nouvel inode) au lieu de le modifier. `node --watch` surveille le fichier
d'origine : il voit le premier remplacement, puis plus rien. J'ai aussi essayé `node --watch-path=src`, avec le même
résultat. C'est le cas « la modification n'est pas toujours détectée » de la slide 7.

**Solution retenue : `action: sync+restart`.** Compose copie le fichier, **puis** redémarre le conteneur. Le
conteneur et l'image restent les mêmes : pas de rebuild.

**Preuve** (3 modifications successives de `/health`, `docker compose watch` actif) :

```bash
# avant : image 7375497c52c6  conteneur f42e3eb3586c
curl localhost:3000/health   # {"status":"UP","mode":"dev","watch":6}
# modif → watch: 7
curl localhost:3000/health   # {"status":"UP","mode":"dev","watch":7}
# modif → watch: 8
curl localhost:3000/health   # {"status":"UP","mode":"dev","watch":8}
# modif → watch: 9
curl localhost:3000/health   # {"status":"UP","mode":"dev","watch":9}
# après : image 7375497c52c6  conteneur f42e3eb3586c   ← même image, même conteneur
```

Sortie de `docker compose watch` :

```
Watch enabled
Syncing service "api" after 2 changes were detected
 Container td3-api-1 Restarting
service(s) ["api"] restarted
```

(×3)

Et la règle `rebuild` : modifier `app/package.json` reconstruit bien l'image (`7375497c52c6` → `4c0780ae413e`,
puis `Container td3-api-1 Recreated`).

Les modifications de test ont été annulées : `app/` est identique à la version fournie.

## C2 — Passer en « prod seule » sans `--build`

```bash
docker compose up -d --build                     # dev
docker compose exec api ps -o args               # npm run dev
docker compose exec api id -un                   # root

docker compose -f compose.yaml up -d             # prod… sans --build
docker compose exec api ps -o args               # npm run dev      ← toujours la version dev !
docker compose exec api id -un                   # root
docker image ls td3-api
# td3-api:latest   df30b1914446   …   U          ← une seule image, utilisée

docker compose -f compose.yaml up -d --build     # prod avec --build
docker compose exec api ps -o args               # node src/server.js
docker compose exec api id -un                   # node
```

**Ce qui se passe :** sans `--build`, le service se lance en « prod » **avec l'image dev** : `npm run dev` en root,
avec les devDependencies et `node --watch`.

**Pourquoi :** Compose nomme l'image d'un service construit `<projet>-<service>`, ici **`td3-api`**, quelle que soit
la cible. Le dev et la prod partagent donc le **même nom d'image**. Sans `--build`, `up` voit qu'une image `td3-api`
existe déjà et la réutilise, sans regarder la `target` demandée. Le changement de `target: dev` à `target: prod` ne
déclenche aucune reconstruction. On croit tester la prod alors qu'on fait tourner le dev.

Il faut donc toujours passer `--build` en changeant de configuration. Une autre solution : donner un nom d'image
différent par environnement (`image: td3-api:dev` dans l'override), pour qu'ils ne s'écrasent plus.
