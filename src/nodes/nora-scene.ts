import { SceneDevice } from '@andrei-tatar/nora-firebase-common';
import { Subject } from 'rxjs';
import { switchMap, takeUntil } from 'rxjs/operators';
import { ConfigNode, NodeInterface } from '..';
import { FirebaseConnection } from '../firebase/connection';
import { DeviceContext } from '../firebase/device-context';
import { convertValueType, getId, getValue, withLocalExecution } from './util';

module.exports = function (RED: any) {
    RED.nodes.registerType('noraf-scene', function (this: NodeInterface, config: any) {
        RED.nodes.createNode(this, config);

        const noraConfig: ConfigNode = RED.nodes.getNode(config.nora);
        if (!noraConfig?.valid) { return; }

        const { value: onValue, type: onType } = convertValueType(RED, config.onvalue, config.onvalueType, { defaultValue: true });
        const { value: offValue, type: offType } = convertValueType(RED, config.offvalue, config.offvalueType, { defaultValue: false });

        const close$ = new Subject<void>();
        const ctx = new DeviceContext(this);
        ctx.update(close$);

        const deviceConfig = noraConfig.setCommon<SceneDevice>({
            id: getId(config),
            type: 'action.devices.types.SCENE',
            traits: ['action.devices.traits.Scene'],
            name: {
                name: config.devicename,
            },
            willReportState: true,
            roomHint: config.roomhint,
            attributes: {
                sceneReversible: !!config.scenereversible,
            },
            state: {
                online: true
            },
            noraSpecific: {
            },
        }, config);

        FirebaseConnection
            .withLogger(RED.log)
            .fromConfig(noraConfig, ctx)
            .pipe(
                switchMap(connection => connection.withDevice(deviceConfig)),
                withLocalExecution(noraConfig),
                switchMap(device => device.activateScene$),
                takeUntil(close$),
            ).subscribe(({ deactivate }) => {
                const value = !deactivate;
                this.send({
                    payload: getValue(RED, this, value ? onValue : offValue, value ? onType : offType),
                    topic: config.topic
                });
            });

        this.on('close', () => {
            close$.next();
            close$.complete();
        });
    });
};

