# bb-plugin-office-files

Файловый менеджер офиса для BB: дерево папок и файлов сервера, открывается
как вкладка в правой панели треда (`threadPanelAction`) — рядом с разговором,
а не отдельным окном.

- `contract.ts` — общие типы между сервером и хостовым воркером.
- `host.ts` — полнодоверенный Node-воркер, который bb запускает прямо на
  подключённой машине офиса. Только здесь есть настоящий доступ к `fs`:
  читает директории (включая скрытые папки вроде `.claude`, `.agents`) и
  содержимое файлов.
- `server.ts` — backend-плагин: выбирает нужную машину (host) и отдаёт RPC
  фронтенду поверх `bb.hosts.experimental_client`.
- `app.tsx` — панель: дерево слева (ленивая подгрузка папок), превью файла
  справа.

## Настройки

```
bb plugin config office-files
bb plugin config office-files set rootPath /home/aikomanda/neuroshtab
bb plugin config office-files set hostId host_xxxxxxxx   # точный выбор машины
bb plugin reload office-files
```

По умолчанию плагин сам находит подключённую машину офиса по подстроке имени
(`hostMatch`, по умолчанию `fastvps`). Если машин несколько и подстрока не
совпала — укажи `hostId` явно (`bb machine list` покажет id).

## Установка

```
bb plugin install git:https://github.com/leonovs0808-star/bb-plugin-office-files.git
```

После правок:

```
bb plugin build .
bb plugin reload office-files
```
