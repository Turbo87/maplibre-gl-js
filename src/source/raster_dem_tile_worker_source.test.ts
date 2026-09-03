import {describe, test, expect, vi, afterEach} from 'vitest';
import {RasterDEMTileWorkerSource} from './raster_dem_tile_worker_source.ts';
import * as util from '../util/util.ts';
import {DEMData} from '../data/dem_data.ts';
import {type WorkerDEMTileParameters} from './worker_source.ts';

describe('loadTile', () => {
    afterEach(() => vi.restoreAllMocks());

    test('decodes ImageBitmap tiles with a two-pixel border', async () => {
        const source = new RasterDEMTileWorkerSource();
        const image = await createImageBitmap(new ImageData(4, 4));
        const getImageData = vi.spyOn(util, 'getImageData').mockResolvedValue(new Uint8ClampedArray(8 * 8 * 4));

        const data = await source.loadTile({
            uid: '0',
            rawImageData: image,
            encoding: 'terrarium'
        } as WorkerDEMTileParameters);

        expect(getImageData).toHaveBeenCalledWith(image, -2, -2, 8, 8);
        expect(data.dim).toBe(4);
        expect(data.stride).toBe(8);
    });

    test('loads DEM tile', async () => {
        const source = new RasterDEMTileWorkerSource();

        const data = await source.loadTile({
            source: 'source',
            uid: '0',
            rawImageData: {data: new Uint8ClampedArray(256), height: 8, width: 8},
            dim: 256
        } as any as WorkerDEMTileParameters);
        expect(Object.keys(source.loaded)).toEqual(['0']);
        expect(data).toBeInstanceOf(DEMData);
        expect(data.dim).toBe(4);
        expect(data.stride).toBe(8);
    });
});

describe('removeTile', () => {
    test('removes loaded tile', () => {
        const source = new RasterDEMTileWorkerSource();

        source.loaded = {
            '0': {} as DEMData
        };

        source.removeTile({
            source: 'source',
            uid: '0',
            type: 'raster-dem',
        });

        expect(source.loaded).toEqual({});
    });
});
