import { encodeAsync } from 'cbor';
import { createSocket, Socket } from 'dgram';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { BehaviorSubject, merge, Observable } from 'rxjs';
import { filter, ignoreElements, switchMap } from 'rxjs/operators';
import { publishReplayRefCountWithDelay } from '..';
import { FirebaseDevice } from '../firebase/device';

const DISCOVERY_PACKET = '021dfa122e51acb0b9ea5fbce02741ba69a37a203bd91027978cf29557cbb5b6';
const DISCOVERY_PORT = 6988;
const DISCOVERY_REPLY_PORT = 6989;
const HTTP_PORT = 6987;

export class LocalExecution {
    private static readonly proxyId = LocalExecution.getUniqueId();

    static readonly instance = new LocalExecution();

    private devices$ = new BehaviorSubject<FirebaseDevice[]>([]);

    private discovery$ = new Observable<{ socket: Socket, data: Buffer, from: string }>(observer => {
        const socket = createSocket('udp4');
        socket.on('message', (msg, rinfo) => observer.next({ socket, data: msg, from: rinfo.address }));
        socket.bind(DISCOVERY_PORT);
        return () => socket.close();
    }).pipe(
        filter(msg => msg.data.compare(Buffer.from(DISCOVERY_PACKET, 'hex')) === 0),
        switchMap(async ({ socket, from }) => {
            const responsePacket = await encodeAsync({
                proxyId: LocalExecution.proxyId,
                port: HTTP_PORT,
            });
            socket.send(responsePacket, DISCOVERY_REPLY_PORT, from);
        }),
    );

    private server$ = new Observable(_ => {
        const server = createServer(async (req, res) => {
            if (req.url === '/nora-local-execution' && req.method === 'POST') {
                const body = await this.readBody<{
                    type: 'EXECUTE',
                    deviceId: string,
                    command: string,
                    params: any,
                }>(req);
                switch (body.type) {
                    case 'EXECUTE':
                        const device = this.devices$.value.find(d => d.cloudId === body.deviceId);
                        this.sendJson(res, device?.executeCommand(body.command, body.params) ?? { online: false });
                        return;
                }
            }

            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('NOT FOUND');
        });
        server.listen(HTTP_PORT);
        return () => server.close();
    });

    private services$ = merge(this.discovery$, this.server$).pipe(
        publishReplayRefCountWithDelay(1000),
    );

    private static getUniqueId() {
        const random = new Array(16).fill(0).map(_ => Math.floor(Math.random() * 255));
        return Buffer.from(random).toString('hex');
    }

    registerDeviceForLocalExecution(device: FirebaseDevice): Observable<never> {
        device.device.otherDeviceIds = [{ deviceId: device.cloudId }];
        device.device.customData = {
            proxyId: LocalExecution.proxyId,
        };
        return merge(
            this.services$,
            new Observable(_ => {
                this.devices$.next(this.devices$.value.concat(device));
                return () => {
                    this.devices$.next(this.devices$.value.filter(v => v !== device));
                };
            })
        ).pipe(
            ignoreElements(),
        );
    }

    private readBody<T>(request: IncomingMessage) {
        return new Promise<T>((resolve, reject) => {
            const body: Uint8Array[] = [];
            request
                .on('data', (chunk) => body.push(chunk))
                .on('error', (err) => reject(err))
                .on('end', () => {
                    try {
                        const bodyString = Buffer.concat(body).toString();
                        resolve(JSON.parse(bodyString));
                    } catch (err) {
                        reject(err);
                    }
                });
        });
    }

    private sendJson(res: ServerResponse, body: any) {
        res.writeHead(200, {
            'content-type': 'application/json'
        });
        res.write(JSON.stringify(body));
        res.end();
    }
}
