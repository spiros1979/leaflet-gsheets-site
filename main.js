/* global L Papa */

/*
 * Script to display two tables from Google Sheets as point and geometry layers using Leaflet
 * The Sheets are then imported using PapaParse and overwrite the initially laded layers
 */

// PASTE YOUR URLs HERE
// these URLs come from Google Sheets 'shareable link' form
// the first is the geometry layer and the second the points
let geomURL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTsAyA0Hpk_-WpKyN1dfqi5IPEIC3rqEiL-uwElxJpw_U7BYntc8sDw-8sWsL87JCDU4lVg2aNi65ES/pub?output=csv";
let pointsURL = "./data/points_2.csv";

window.addEventListener("DOMContentLoaded", init);

let map;
let sidebar;
let panelID = "my-info-panel";

// --- [C2/C3] Globals για geolocation & spatial filter ---
let userLayer;                 // layer της θέσης χρήστη
let lastUserLatLng = null;     // τελευταία θέση χρήστη (LatLng)
let userIcon;                  // custom icon για τη "θέση μου"

let pointsGroup;               // layer group με όλα τα points
let pointsMarkers = [];        // όλα τα L.marker από τα points
let filterMode = "user";       // 'user' | 'click'
let filterCenter = null;       // L.LatLng κέντρο φίλτρου
let filterRadius = 1000;       // ακτίνα φίλτρου (m)
let filterOverlay;             // κύκλος φίλτρου
let filterCenterMarker;        // marker κέντρου όταν είναι από κλικ
let filterEnabled = true;      // ON/OFF χωρικού φίλτρου

/*
 * init() is called when the page has loaded
 */
function init() {
  // Create a new Leaflet map centered on London-ish για αρχή
  map = L.map("map").setView([51.5, -0.1], 14);

  // This is the Carto Positron basemap
  L.tileLayer(
    "https://cartodb-basemaps-{s}.global.ssl.fastly.net/light_all/{z}/{x}/{y}{r}.png",
    {
      attribution:
        "&copy; <a href='http://www.openstreetmap.org/copyright'>OpenStreetMap</a> &copy; <a href='http://cartodb.com/attributions'>CartoDB</a>",
      subdomains: "abcd",
      maxZoom: 19,
    }
  ).addTo(map);

  sidebar = L.control
    .sidebar({
      container: "sidebar",
      closeButton: true,
      position: "right",
    })
    .addTo(map);

  let panelContent = {
    id: panelID,
    tab: "<i class='fa fa-bars active'></i>",
    pane: "<p id='sidebar-content'></p>",
    title: "<h2 id='sidebar-title'>Nothing selected</h2>",
  };
  sidebar.addPanel(panelContent);

  map.on("click", function () {
    sidebar.close(panelID);
  });

  // --- [C2] Geolocation με custom icon ---

  userLayer = L.layerGroup().addTo(map);

  // Custom PNG icon (π.χ. assets/new_pointer.png, 128x128 → 32x32 στην οθόνη)
  userIcon = L.icon({
    iconUrl: "./assets/new_pointer.png",
    iconSize: [32, 32],
    iconAnchor: [16, 32],
    popupAnchor: [0, -28],
  });

  // Όταν βρεθεί η θέση
  map.on("locationfound", (e) => {
    userLayer.clearLayers(); // κράτα μόνο την πιο πρόσφατη ένδειξη
    lastUserLatLng = e.latlng;

    // Marker στη θέση με το custom icon
    L.marker(e.latlng, { icon: userIcon })
      .addTo(userLayer)
      .bindPopup(`<b>Η θέση μου</b><br>Ακρίβεια ~${Math.round(e.accuracy)} m`);

    // Κύκλος ακρίβειας (σε μέτρα)
    L.circle(e.latlng, {
      radius: e.accuracy,
      weight: 1,
      fillOpacity: 0.15,
    }).addTo(userLayer);

    // Αν το φίλτρο είναι σε "user", ενημέρωσε κέντρο/κύκλο και εφάρμοσε
    if (filterMode === "user" && filterEnabled) {
      setFilterCenter(e.latlng);
      applySpatialFilter();
    }
  });

  // Αν αποτύχει ο εντοπισμός
  map.on("locationerror", (e) => {
    console.warn("Location error:", e.message);
    alert("Δεν ήταν δυνατός ο εντοπισμός θέσης. Έλεγξε τα δικαιώματα τοποθεσίας στον browser.");
  });

  // Ζήτησε εντοπισμό μία φορά στο φόρτωμα
  map.locate({
    setView: true,
    maxZoom: 16,
    enableHighAccuracy: true,
    timeout: 10000,
    maximumAge: 0,
  });

  // --- [C3] Χωρική επίγνωση (UI + λογική φίλτρου) ---

  // Layer group για τα points & overlays φίλτρου
  pointsGroup = L.layerGroup().addTo(map);
  filterOverlay = L.layerGroup().addTo(map);

  // Control επάνω αριστερά: επιλογή κέντρου & ακτίνας + counter + ON/OFF
  const spatialCtl = L.control({ position: "topleft" });
  spatialCtl.onAdd = function () {
    const div = L.DomUtil.create("div", "leaflet-bar p-2");
    div.style.background = "white";
    div.style.padding = "8px";
    div.style.minWidth = "210px";
    div.style.font = "12px/1.2 Arial, sans-serif";

    div.innerHTML = `
      <div style="margin-bottom:6px;">
        <strong>Χωρικό φίλτρο</strong>
      </div>
      <label style="display:block;margin-bottom:4px;">
        <input type="checkbox" id="sf-enabled" checked>
        <span>Ενεργό</span>
      </label>
      <label style="display:block;margin-bottom:6px;">
        Κέντρο:
        <select id="sf-mode" style="width:100%;">
          <option value="user" selected>📍 Η θέση μου</option>
          <option value="click">🖱️ Κλικ στον χάρτη</option>
        </select>
      </label>
      <label style="display:block;margin-bottom:6px;">
        Ακτίνα: <span id="sf-radius-val">${filterRadius}</span> m
        <input id="sf-radius" type="range" min="100" max="5000" step="100" value="${filterRadius}" style="width:100%;">
      </label>
      <div style="display:flex; gap:6px;">
        <button id="sf-apply" title="Εφαρμογή τώρα" style="flex:1;">Εφαρμογή</button>
        <button id="sf-relocate" title="Εντοπισμός ξανά" style="flex:1;">📍</button>
      </div>
      <div id="sf-count" style="margin-top:6px;opacity:0.8;">Εμφανίζονται: – / –</div>
    `;

    // stop map drag on control interactions
    L.DomEvent.disableClickPropagation(div);

    // wire events
    const enabledChk = div.querySelector("#sf-enabled");
    const modeSel = div.querySelector("#sf-mode");
    const radInp = div.querySelector("#sf-radius");
    const radVal = div.querySelector("#sf-radius-val");
    const btnApply = div.querySelector("#sf-apply");
    const btnReloc = div.querySelector("#sf-relocate");

    enabledChk.addEventListener("change", () => {
      filterEnabled = enabledChk.checked;

      if (!filterEnabled) {
        // Απενεργοποίηση: καθάρισε κέντρο και overlays, δείξε όλα
        filterCenter = null;
        filterOverlay.clearLayers();
        pointsMarkers.forEach((m) => {
          m.setOpacity(1);
          if (m._icon) m._icon.style.pointerEvents = "auto";
        });
        updateCount(pointsMarkers.length, pointsMarkers.length);
      } else {
        // Ενεργοποίηση: ο χρήστης πατάει "Εφαρμογή" για να οριστεί κέντρο/ακτίνα
      }
    });

    modeSel.addEventListener("change", () => {
      filterMode = modeSel.value;
      if (!filterEnabled) return;

      if (filterMode === "user") {
        if (lastUserLatLng) {
          setFilterCenter(lastUserLatLng);
          applySpatialFilter();
        } else {
          // ζήτησε πάλι τοποθεσία αν δεν έχουμε
          map.locate({
            setView: true,
            maxZoom: 16,
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0,
          });
        }
      } else {
        // click mode: περίμενε κλικ, δείξε μήνυμα στο status
        alert("Κάνε κλικ στο χάρτη για να ορίσεις κέντρο φίλτρου.");
      }
    });

    radInp.addEventListener("input", () => {
      filterRadius = Number(radInp.value);
      radVal.textContent = filterRadius;
    });

    btnApply.addEventListener("click", () => {
      if (!filterEnabled) return;

      if (filterMode === "user") {
        if (lastUserLatLng) {
          setFilterCenter(lastUserLatLng);
          applySpatialFilter();
        } else {
          alert("Δεν έχει εντοπιστεί ακόμη η θέση σου.");
        }
      } else {
        if (!filterCenter) {
          alert("Κάνε κλικ στο χάρτη για να ορίσεις κέντρο.");
        } else {
          applySpatialFilter();
        }
      }
    });

    btnReloc.addEventListener("click", () => {
      map.locate({
        setView: true,
        maxZoom: 16,
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      });
    });

    return div;
  };
  spatialCtl.addTo(map);

  // Στο click mode, κλικ στον χάρτη → όρισε κέντρο & εφάρμοσε
  map.on("click", (e) => {
    if (filterMode !== "click" || !filterEnabled) return;
    setFilterCenter(e.latlng, { showMarker: true });
    applySpatialFilter();
  });

  // Φόρτωση δεδομένων από τα Google Sheets/CSV με PapaParse
  Papa.parse(geomURL, {
    download: true,
    header: true,
    complete: addGeoms,
  });
  Papa.parse(pointsURL, {
    download: true,
    header: true,
    complete: addPoints,
  });
}

/*
 * Ορίζει το κέντρο του φίλτρου και ζωγραφίζει κύκλο/marker κέντρου
 */
function setFilterCenter(latlng, opts = {}) {
  const { showMarker = (filterMode === "click") } = opts;

  filterCenter = latlng;

  // καθάρισε προηγούμενα overlays
  filterOverlay.clearLayers();

  // κύκλος φίλτρου
  L.circle(filterCenter, {
    radius: filterRadius,
    color: "#1e88e5",
    weight: 2,
    fillColor: "#90caf9",
    fillOpacity: 0.15,
  }).addTo(filterOverlay);

  // marker κέντρου όταν είμαστε σε click mode (ώστε να φαίνεται το σημείο)
  if (showMarker) {
    if (filterCenterMarker) {
      filterOverlay.removeLayer(filterCenterMarker);
      filterCenterMarker = null;
    }
    filterCenterMarker = L.marker(filterCenter, {
      opacity: 0.8,
      title: "Κέντρο φίλτρου",
    }).addTo(filterOverlay);
  }
}

/*
 * Xωρικό φίλτρο στα points (εμφάνιση/απόκρυψη)
 */
function applySpatialFilter() {
  if (!pointsMarkers.length) { updateCount(); return; }

  // Αν το φίλτρο είναι OFF: δείξε όλα
  if (!filterEnabled) {
    for (const m of pointsMarkers) {
      m.setOpacity(1);
      if (m._icon) m._icon.style.pointerEvents = "auto";
    }
    updateCount(pointsMarkers.length, pointsMarkers.length);
    return;
  }

  // Αν δεν έχει οριστεί κέντρο, δείξε όλα κανονικά
  if (!filterCenter) {
    for (const m of pointsMarkers) {
      m.setOpacity(1);
      if (m._icon) m._icon.style.pointerEvents = "auto";
    }
    updateCount(pointsMarkers.length, pointsMarkers.length);
    return;
  }

  let visible = 0;
  for (const m of pointsMarkers) {
    const d = map.distance(filterCenter, m.getLatLng()); // μέτρα
    const isIn = d <= filterRadius;

    // Εντός: πλήρως ορατό και κλικαμπλ — Εκτός: αόρατο και μη κλικαμπλ
    m.setOpacity(isIn ? 1 : 0);
    if (m._icon) m._icon.style.pointerEvents = isIn ? "auto" : "none";

    if (isIn) visible++;
  }
  updateCount(visible, pointsMarkers.length);
}

function updateCount(visible = 0, total = pointsMarkers.length || 0) {
  const el = document.getElementById("sf-count");
  if (el) el.textContent = `Εμφανίζονται: ${visible} / ${total}`;
}

/*
 * Expects a JSON representation of the table with properties columns
 * and a 'geometry' column that can be parsed by parseGeom()
 */
function addGeoms(data) {
  data = data.data;
  // Need to convert the PapaParse JSON into a GeoJSON
  // Start with an empty GeoJSON of type FeatureCollection
  // All the rows will be inserted into a single GeoJSON
  let fc = {
    type: "FeatureCollection",
    features: [],
  };

  for (let row in data) {
    // The Sheets data has a column 'include' that specifies if that row should be mapped
    if (data[row].include == "y") {
      let features = parseGeom(JSON.parse(data[row].geometry));
      features.forEach((el) => {
        el.properties = {
          name: data[row].name,
          description: data[row].description,
        };
        fc.features.push(el);
      });
    }
  }

  // The geometries are styled slightly differently on mouse hovers
  let geomStyle = { color: "#2ca25f", fillColor: "#99d8c9", weight: 2 };
  let geomHoverStyle = { color: "green", fillColor: "#2ca25f", weight: 3 };

  L.geoJSON(fc, {
    onEachFeature: function (feature, layer) {
      layer.on({
        mouseout: function (e) {
          e.target.setStyle(geomStyle);
        },
        mouseover: function (e) {
          e.target.setStyle(geomHoverStyle);
        },
        click: function (e) {
          // if this isn't added, then map.click is also fired!
          L.DomEvent.stopPropagation(e);

          document.getElementById("sidebar-title").innerHTML =
            e.target.feature.properties.name;
          document.getElementById("sidebar-content").innerHTML =
            e.target.feature.properties.description;
          sidebar.open(panelID);
        },
      });
    },
    style: geomStyle,
  }).addTo(map);
}

/*
 * addPoints is a bit simpler, as no GeoJSON is needed for the points
 */
function addPoints(data) {
  data = data.data;

  // αν υπήρχε παλιό group/λίστα, καθάρισέ τα (σε επαναφορτώσεις)
  pointsGroup.clearLayers();
  pointsMarkers = [];

  // Choose marker type. Options are:
  // marker | circleMarker (px) | circle (m)
  let markerType = "marker";
  let markerRadius = 100;

  for (let row = 0; row < data.length; row++) {
    // skip κενές γραμμές
    if (!data[row].lat || !data[row].lon) continue;

    let marker;
    const lat = Number(data[row].lat);
    const lon = Number(data[row].lon);

    if (markerType == "circleMarker") {
      marker = L.circleMarker([lat, lon], { radius: markerRadius });
    } else if (markerType == "circle") {
      marker = L.circle([lat, lon], { radius: markerRadius });
    } else {
      marker = L.marker([lat, lon]);
    }

    marker.addTo(pointsGroup);

    // Sidebar info
    marker.feature = {
      properties: {
        name: data[row].name,
        description: data[row].description,
      },
    };
    marker.on({
      click: function (e) {
        L.DomEvent.stopPropagation(e);
        document.getElementById("sidebar-title").innerHTML =
          e.target.feature.properties.name;
        document.getElementById("sidebar-content").innerHTML =
          e.target.feature.properties.description;
        sidebar.open(panelID);
      },
    });

    // Optional AwesomeMarkers icon για τα data points (ό,τι υπήρχε)
    if (L.AwesomeMarkers && L.AwesomeMarkers.icon && !markerType.includes("circle")) {
      const icon = L.AwesomeMarkers.icon({
        icon: "info-circle",
        iconColor: "white",
        markerColor: data[row].color || "blue",
        prefix: "fa",
        extraClasses: "fa-rotate-0",
      });
      marker.setIcon(icon);
    }

    pointsMarkers.push(marker);
  }

  // εφάρμοσε φίλτρο αν υπάρχει κέντρο
  applySpatialFilter();
}

/*
 * Accepts any GeoJSON-ish object and returns an Array of
 * GeoJSON Features. Attempts to guess the geometry type
 * when a bare coordinates Array is supplied.
 */
function parseGeom(gj) {
  // FeatureCollection
  if (gj.type == "FeatureCollection") {
    return gj.features;
  }

  // Feature
  else if (gj.type == "Feature") {
    return [gj];
  }

  // Geometry
  else if ("type" in gj) {
    return [{ type: "Feature", geometry: gj }];
  }

  // Coordinates
  else {
    let type;
    if (typeof gj[0] == "number") {
      type = "Point";
    } else if (typeof gj[0][0] == "number") {
      type = "LineString";
    } else if (typeof gj[0][0][0] == "number") {
      type = "Polygon";
    } else {
      type = "MultiPolygon";
    }
    return [{ type: "Feature", geometry: { type: type, coordinates: gj } }];
  }
}

