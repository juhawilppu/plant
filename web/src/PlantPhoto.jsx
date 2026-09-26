import React, { useCallback, useState } from 'react';
import plantAvif640 from './assets/photos/monstera-640.avif';
import plantAvif960 from './assets/photos/monstera-960.avif';
import plantAvif1280 from './assets/photos/monstera-1280.avif';
import plantWebp640 from './assets/photos/monstera-640.webp';
import plantWebp960 from './assets/photos/monstera-960.webp';
import plantWebp1280 from './assets/photos/monstera-1280.webp';
import probeAvif400 from './assets/photos/probe-400.avif';
import probeAvif800 from './assets/photos/probe-800.avif';
import probeWebp400 from './assets/photos/probe-400.webp';
import probeWebp800 from './assets/photos/probe-800.webp';

// The plant itself, on the hero card beside the number it is measured for, and
// the probe that does the measuring. Decoration, not data: it says nothing about
// any reading, so it shows straight away, even before the first fetch returns.
//
// The whole plant is always in frame, pot included. The photo is a portrait
// and the plant fills nearly all of it, so no frame wider than the photo can
// show both the top leaf and the saucer. Every frame here is therefore the
// photo's own shape or narrower, and any crop comes off the sides:
//
//   below 1000px   a diptych above the number: the plant in a cell of exactly
//                  its own shape, the probe filling the rest of the banner
//   from 1000px    a column beside the number, never wider than 339px and
//                  never shorter than 400px, with the probe as a round inset
//
// The sizes below describe those two layouts (see .hero-photo in theme.css).
const PLANT_SIZES = '(min-width: 1000px) 340px, (min-width: 681px) 320px, calc(50vw - 22px)';
const PROBE_SIZES = '(min-width: 1000px) 88px, (min-width: 681px) calc(100vw - 364px), calc(50vw - 22px)';

// One photo that fades in once it has arrived, over the card's own green, so
// nothing shifts when it lands.
function Photo({ className, avif, webp, fallback, sizes, width, height, alt, priority }) {
    const [loaded, setLoaded] = useState(false);
    // A cached photo can finish loading before React attaches onLoad, and then
    // the event never fires; the ref catches that case.
    const settle = useCallback((img) => {
        if (img?.complete) setLoaded(true);
    }, []);

    return (
        <picture className={loaded ? `${className} is-loaded` : className}>
            <source type="image/avif" srcSet={avif} sizes={sizes} />
            <img
                ref={settle}
                onLoad={() => setLoaded(true)}
                src={fallback}
                srcSet={webp}
                sizes={sizes}
                width={width}
                height={height}
                // Lower case: React 18 passes it through as a plain attribute.
                fetchpriority={priority ? 'high' : undefined}
                alt={alt}
            />
        </picture>
    );
}

export default function PlantPhoto() {
    return (
        <div className="hero-photo">
            <Photo
                className="hero-photo-plant"
                avif={`${plantAvif640} 640w, ${plantAvif960} 960w, ${plantAvif1280} 1280w`}
                webp={`${plantWebp640} 640w, ${plantWebp960} 960w, ${plantWebp1280} 1280w`}
                fallback={plantWebp960}
                sizes={PLANT_SIZES}
                width="960"
                height="1139"
                priority
                alt="The Monstera, climbing a moss pole in a white pot by the window, with the sensor node on the floor beside it."
            />
            <Photo
                className="hero-photo-probe"
                avif={`${probeAvif400} 400w, ${probeAvif800} 800w`}
                webp={`${probeWebp400} 400w, ${probeWebp800} 800w`}
                fallback={probeWebp400}
                sizes={PROBE_SIZES}
                width="400"
                height="474"
                alt="The capacitive soil moisture probe, pushed into the soil at the base of the plant."
            />
        </div>
    );
}
