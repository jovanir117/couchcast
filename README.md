# TV Cast

Extensión de Chrome que manda el video de la página a una tele Samsung (Tizen) por la red de la casa. La tele lo reproduce con su propio reproductor: fluido y a calidad completa, sin duplicar la pantalla.

- **YouTube**: abre el video en la app de YouTube de la tele (DIAL), en el mismo segundo.
- **Otros sitios**: busca el video que está sonando (también dentro de iframes) y se lo pasa a la tele por DLNA. Con HLS elige la mejor calidad de entrada.
- **Sin configurar nada**: encuentra la tele en la red y la vuelve a encontrar si el router le cambia la IP.
- **Controles**: pausa, play, detener, volumen y prender la tele.

## Instalar

1. `chrome://extensions` → activa *Modo de desarrollador* → *Cargar descomprimida* → esta carpeta.
2. Abre una página con video, dale play y pica el ícono de TV Cast.

## Relay en la PC (opcional)

Algunos sitios solo le dan el video a un navegador (revisan Referer, Origin o cookies). El relay corre en la PC, pide el video con los datos del navegador y se lo pasa a la tele tal cual, sin recodificar. También manda el paquete Wake-on-LAN para prender la tele desde el popup.

```
node relay/relay.js            # escucha en el puerto 8723, solo acepta la red local
node relay/relay.js --selftest
```

En Windows, `relay/iniciar.vbs` lo arranca oculto y lo reinicia si se cae; pon un acceso directo en la carpeta de Inicio para que arranque solo.

Para prender la tele desde el popup, en la tele activa *Encender con dispositivo móvil* (Ajustes › General › Red › Ajustes de expertos) y préndela una vez con el control para que la extensión aprenda su MAC.

## Límites

- Sitios con DRM (Netflix, Disney+…) no dan un archivo de video: usa su app en la tele.
- Algunos sitios solo entregan el video a Chrome (huella TLS); ni el relay puede sacarlo.
- Probado con una Samsung OLED con Tizen; otras teles DLNA deberían servir para el video, no para el estado ni el encendido.
