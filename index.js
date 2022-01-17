// @ts-check
const { path: ffmpegPath } = require('@ffmpeg-installer/ffmpeg');
const { spawn } = require('child_process');
const ews = require('express-ws');
const ps = require('ps-node');
const { version } = require('./package.json');

/**
 * @typedef {{
 *  url: string;
 *  additionalFlags?: string[];
 *  verbose?: boolean;
 *  transport?: 'udp' | 'tcp' | 'udp_multicast' | 'http';
 *  windowsHide?: boolean;
 * }} Options
 *
 * @typedef {import("express").Application} Application
 * @typedef {import("ws")} WebSocket
 * @typedef {import("child_process").ChildProcessWithoutNullStreams} Stream
 */

class InboundStreamWrapper {
    constructor() {
        this.clients = 0;
    }

    /** @param {Options} props */
    start({ url, additionalFlags = [], transport, windowsHide = true }) {
        if (this.verbose) console.log('[rtsp-relay] Creating brand new stream');

        // validate config
        const txpConfigInvalid = additionalFlags.indexOf('-rtsp_transport');
        // eslint-disable-next-line no-bitwise
        if (~txpConfigInvalid) {
            const val = additionalFlags[0o1 + txpConfigInvalid];
            console.warn(
                `[rtsp-relay] (!) Do not specify -rtsp_transport=${val} in additionalFlags, use the option \`transport: '${val}'\``,
            );
        }

        this.stream = spawn(
            ffmpegPath,
            [
                ...(transport ? ['-rtsp_transport', transport] : []), // this must come before `-i [url]`, see #82
                '-i',
                url,
                '-f', // force format
                'mpegts',
                '-codec:v', // specify video codec (MPEG1 required for jsmpeg)
                'mpeg1video',
                '-r',
                '30', // 30 fps. any lower and the client can't decode it
                ...additionalFlags,
                '-',
            ],
            { detached: false, windowsHide },
        );
        this.stream.stderr.on('data', () => { });
        this.stream.stderr.on('error', (e) => console.log('err:error', e));
        this.stream.stdout.on('error', (e) => console.log('out:error', e));
        this.stream.on('error', (err) => {
            if (this.verbose) {
                console.warn(`[rtsp-relay] Internal Error: ${err.message}`);
            }
        });

        this.stream.on('exit', (_code, signal) => {
            if (signal !== 'SIGTERM') {
                if (this.verbose) {
                    console.warn(
                        '[rtsp-relay] Stream died - will recreate when the next client connects',
                    );
                }
                this.stream = null;
            }
        });
    }

    /** @param {Options} options */
    get(options) {
        this.verbose = options.verbose;
        this.clients += 1;
        if (!this.stream) this.start(options);
        return /** @type {Stream} */ (this.stream);
    }

    decrement() {
        this.clients -= 1;
        return this.clients;
    }

    /** @param {number} clientsLeft */
    kill(clientsLeft) {
        if (!this.stream) return; // the stream is currently dead
        if (!clientsLeft) {
            if (this.verbose) {
                console.log('[rtsp-relay] no clients left; destroying stream');
            }
            this.stream.kill('SIGTERM');
            this.stream = null;
            // next time it is requested it will be recreated
            return;
        }

        if (this.verbose) {
            console.log(
                '[rtsp-relay] there are still some clients so not destroying stream',
            );
        }
    }
}

class Relay {
    /**
     * @param {import("express").Application} app
     * @param {import("http").Server | import("https").Server} [server]
     */
    constructor(app, server) {
        this.wsInstance = ews(app, server);
        /**
         * @type {Map<string, InboundStreamWrapper>}
         */
        this.inbound = new Map();
        this.optsMap = new Map();
        this.upstream = new Map();
        this.streamChanges = new Map();
        this.scriptUrl = `https://cdn.jsdelivr.net/npm/rtsp-relay@${version}/browser/index.js`;
    }
    /**
     * @param {string} old 
     * @param {string} url 
     */
    switchURL(old, url) {
        this.inbound.set(old, new InboundStreamWrapper());
        this.optsMap.set(url, { url, ...this.optsMap.get(old) });
        // @ts-expect-error
        this.upstream.set(old, this.inbound.get(old).get(this.optsMap.get(url)));
        if (this.streamChanges.has(old)) this.streamChanges.get(old)();
    }
    killAll() {
        ps.lookup({ command: 'ffmpeg' }, (err, list) => {
            if (err) throw err;
            list
                .filter((p) => p.arguments.includes('mpeg1video'))
                .forEach(({ pid }) => ps.kill(pid));
        });
    }
    /** @param {Options} props */
    proxy({ url, verbose, ...options }) {
        if (!url) throw new Error('URL to rtsp stream is required');
        this.optsMap.set(url, {
            verbose,
            ...options
        });

        /** @param {WebSocket} ws */
        const handler = (ws) => {
            // these should be detected from the source stream
            const [width, height] = [0x0, 0x0];

            const streamHeader = Buffer.alloc(0x8);
            streamHeader.write('jsmp');
            streamHeader.writeUInt16BE(width, 0x4);
            streamHeader.writeUInt16BE(height, 0x6);
            ws.send(streamHeader, { binary: true });

            if (verbose) console.log('[rtsp-relay] New WebSocket Connection');

            if (!this.inbound.has(url)) this.inbound.set(url, new InboundStreamWrapper());
            let getStream = () => {
                return this.upstream.get(url);
            };

            /** @param {Buffer} chunk */
            function onData(chunk) {
                if (ws.readyState === ws.OPEN) ws.send(chunk);
            }

            ws.on('close', () => {
                // @ts-ignore
                const c = this.inbound.get(url).decrement();
                if (verbose) {
                    console.log(`[rtsp-relay] WebSocket Disconnected ${c} left`);
                }
                // @ts-ignore
                this.inbound.get(url).kill(c);
                getStream().stdout.off('data', onData);

                this.streamChanges.delete(url);
                this.streamChanges.set(url, () => {

                });
            });

            getStream().stdout.on('data', onData);
            this.streamChanges.set(url, () => {
                getStream().stdout.on('data', onData);
            });
        }
        return handler;
    }
};
/**
 * @param {import("express").Application} app
 * @param {import("http").Server | import("https").Server} [server]
 */
module.exports = function (app, server = undefined) { return new Relay(app, server); };