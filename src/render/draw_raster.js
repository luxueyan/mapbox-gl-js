// @flow

import {clamp} from '../util/util';

import ImageSource from '../source/image_source';
import browser from '../util/browser';
import StencilMode from '../gl/stencil_mode';
import DepthMode from '../gl/depth_mode';
import CullFaceMode from '../gl/cull_face_mode';
import {rasterUniformValues} from './program/raster_program';

import type Painter from './painter';
import type SourceCache from '../source/source_cache';
import type RasterStyleLayer from '../style/style_layer/raster_style_layer';
import type {OverscaledTileID} from '../source/tile_id';

import coordtransform from 'coordtransform'

function tileCoordsToLonLat(x, y, z) {
  // const n = Math.pow(2, z)
  // const lon_deg = x / n * 360.0 - 180.0
  // const lat_rad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)))
  // const lat_deg = lat_rad * 180.0 / Math.PI
  return [tile2long(x,z), tile2lat(y,z)]
}
function lonLatToTileCoords(lon, lat, zoom) {
  return [lon2tile(lon, zoom), lat2tile(lat,zoom)]
}
function lon2tile(lon,zoom) { return (Math.floor((lon+180)/360*Math.pow(2,zoom))); }
function lat2tile(lat,zoom)  { return (Math.floor((1-Math.log(Math.tan(lat*Math.PI/180) + 1/Math.cos(lat*Math.PI/180))/Math.PI)/2 *Math.pow(2,zoom))); }
function tile2long(x,z) {
  return (x/Math.pow(2,z)*360-180);
 }
function tile2lat(y,z) {
  var n=Math.PI-2*Math.PI*y/Math.pow(2,z);
  return (180/Math.PI*Math.atan(0.5*(Math.exp(n)-Math.exp(-n))));
}

export default drawRaster;

function drawRaster(painter: Painter, sourceCache: SourceCache, layer: RasterStyleLayer, tileIDs: Array<OverscaledTileID>) {
    if (painter.renderPass !== 'translucent') return;
    if (layer.paint.get('raster-opacity') === 0) return;
    if (!tileIDs.length) return;

    const context = painter.context;
    const gl = context.gl;
    const source = sourceCache.getSource();
    const program = painter.useProgram('raster');

    const colorMode = painter.colorModeForRenderPass();

    const [stencilModes, coords] = source instanceof ImageSource ? [{}, tileIDs] :
        painter.stencilConfigForOverlap(tileIDs);

    const minTileZ = coords[coords.length - 1].overscaledZ;

    const align = !painter.options.moving;
    let tPointX = 0;
    let tPointY = 0;
    if (layer.metadata.coordinate === 'GCJ02' && coords.length) {
        const coord1 = coords[0];
        const unwrappedTileID1 = coord1.toUnwrapped();
        const canonical = unwrappedTileID1.canonical;
        const lnglat = tileCoordsToLonLat(canonical.x, canonical.y, canonical.z);
        const gcj = coordtransform.wgs84togcj02(lnglat[0], lnglat[1]);
        const wgs84Point = painter.transform.locationPoint2(lnglat);
        const gcjPoint = painter.transform.locationPoint2(gcj);
        tPointX = (wgs84Point.x - gcjPoint.x) | 0;
        tPointY = (wgs84Point.y - gcjPoint.y) | 0;
        // const tPointX = -249
        // const tPointY = -85
        // const mercator = new MercatorCoordinate(canonical.x, canonical.y, canonical.z)
        // centerOffset = new Point(tPointX, tPointY)
        // if (canonical.x === 53927 && canonical.y === 26291) {
        //   console.log(lnglat, gcj, tPointX, tPointY, canonical.y )
        // }

        // posMatrix = painter.translatePosMatrix(posMatrix, tile, [tPointX / 2, tPointY / 2], 'map');
        // mat4.rotateX(m, m, this._pitch);
        // mat4.rotateZ(m, m, this.angle);
    }

    for (const coord of coords) {
        // Set the lower zoom level to sublayer 0, and higher zoom levels to higher sublayers
        // Use gl.LESS to prevent double drawing in areas where tiles overlap.
        const depthMode = painter.depthModeForSublayer(coord.overscaledZ - minTileZ,
            layer.paint.get('raster-opacity') === 1 ? DepthMode.ReadWrite : DepthMode.ReadOnly, gl.LESS);

        const tile = sourceCache.getTile(coord);
        // const posMatrix = painter.transform.calculatePosMatrix(coord.toUnwrapped(), align);
        const unwrappedTileID = coord.toUnwrapped();
        let posMatrix = painter.transform.calculatePosMatrix(unwrappedTileID, align);
        if (layer.metadata.coordinate === 'GCJ02') {
            posMatrix = painter.translatePosMatrix(posMatrix, tile, [tPointX / 2, tPointY / 2], 'map');
        }
        tile.registerFadeDuration(layer.paint.get('raster-fade-duration'));

        const parentTile = sourceCache.findLoadedParent(coord, 0),
            fade = getFadeValues(tile, parentTile, sourceCache, layer, painter.transform);

        let parentScaleBy, parentTL;

        const textureFilter = layer.paint.get('raster-resampling') === 'nearest' ?  gl.NEAREST : gl.LINEAR;

        context.activeTexture.set(gl.TEXTURE0);
        tile.texture.bind(textureFilter, gl.CLAMP_TO_EDGE, gl.LINEAR_MIPMAP_NEAREST);

        context.activeTexture.set(gl.TEXTURE1);

        if (parentTile) {
            parentTile.texture.bind(textureFilter, gl.CLAMP_TO_EDGE, gl.LINEAR_MIPMAP_NEAREST);
            parentScaleBy = Math.pow(2, parentTile.tileID.overscaledZ - tile.tileID.overscaledZ);
            parentTL = [tile.tileID.canonical.x * parentScaleBy % 1, tile.tileID.canonical.y * parentScaleBy % 1];

        } else {
            tile.texture.bind(textureFilter, gl.CLAMP_TO_EDGE, gl.LINEAR_MIPMAP_NEAREST);
        }

        const uniformValues = rasterUniformValues(posMatrix, parentTL || [0, 0], parentScaleBy || 1, fade, layer);

        if (source instanceof ImageSource) {
            program.draw(context, gl.TRIANGLES, depthMode, StencilMode.disabled, colorMode, CullFaceMode.disabled,
                uniformValues, layer.id, source.boundsBuffer,
                painter.quadTriangleIndexBuffer, source.boundsSegments);
        } else {
            program.draw(context, gl.TRIANGLES, depthMode, stencilModes[coord.overscaledZ], colorMode, CullFaceMode.disabled,
                uniformValues, layer.id, painter.rasterBoundsBuffer,
                painter.quadTriangleIndexBuffer, painter.rasterBoundsSegments);
        }
    }
}

function getFadeValues(tile, parentTile, sourceCache, layer, transform) {
    const fadeDuration = layer.paint.get('raster-fade-duration');

    if (fadeDuration > 0) {
        const now = browser.now();
        const sinceTile = (now - tile.timeAdded) / fadeDuration;
        const sinceParent = parentTile ? (now - parentTile.timeAdded) / fadeDuration : -1;

        const source = sourceCache.getSource();
        const idealZ = transform.coveringZoomLevel({
            tileSize: source.tileSize,
            roundZoom: source.roundZoom
        });

        // if no parent or parent is older, fade in; if parent is younger, fade out
        const fadeIn = !parentTile || Math.abs(parentTile.tileID.overscaledZ - idealZ) > Math.abs(tile.tileID.overscaledZ - idealZ);

        const childOpacity = (fadeIn && tile.refreshedUponExpiration) ? 1 : clamp(fadeIn ? sinceTile : 1 - sinceParent, 0, 1);

        // we don't crossfade tiles that were just refreshed upon expiring:
        // once they're old enough to pass the crossfading threshold
        // (fadeDuration), unset the `refreshedUponExpiration` flag so we don't
        // incorrectly fail to crossfade them when zooming
        if (tile.refreshedUponExpiration && sinceTile >= 1) tile.refreshedUponExpiration = false;

        if (parentTile) {
            return {
                opacity: 1,
                mix: 1 - childOpacity
            };
        } else {
            return {
                opacity: childOpacity,
                mix: 0
            };
        }
    } else {
        return {
            opacity: 1,
            mix: 0
        };
    }
}
