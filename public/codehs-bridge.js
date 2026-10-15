/*
 * codehs-bridge.js: lets a parent page embed GEARS in an iframe.
 *
 * Copyright (C) 2026 CodeHS
 *
 * This file is part of a modified version of GEARS and is distributed under
 * the GNU General Public License v3.0 (see ../LICENSE). It touches GEARS
 * internals, so it lives in the GEARS app, not in the embedding site.
 *
 * The bridge only switches on when the page is loaded with
 * ?embedOrigin=<parent origin>. Otherwise GEARS runs unchanged.
 *
 * Protocol. Every message is an object { source: 'gears-bridge', type, ... }.
 *   GEARS  -> parent  ready                       scene is loaded, send init
 *   parent -> GEARS   init { world, project, challenge, lockWorld, update }
 *                     (ignored after the first unless update is true)
 *   GEARS  -> parent  initialized
 *   GEARS  -> parent  project { project }         blocks or Python changed
 *   GEARS  -> parent  run                         the program started
 *   GEARS  -> parent  result { passed, reason, position, elapsedMs }
 *   parent -> GEARS   getState { requestId }
 *   GEARS  -> parent  state { requestId, world, project, position }
 *
 * world:     a GEARS world file ({ worldName, options }), as saved from the
 *            Worlds menu.
 * project:   { blocksXml, files: { 'main.py': ... }, pythonModified }
 * challenge: { goalZone: { x, y, width, length }, timeLimitSeconds }
 *            A run is checked only when it starts from the reset position;
 *            otherwise the result is { passed: false, reason: 'not_from_start' }.
 *            Coordinates are GEARS world coordinates in cm, (0, 0) at the
 *            center of the field, y pointing away from the default camera.
 */
(function() {
  'use strict';

  var SOURCE = 'gears-bridge';
  var GOAL_ZONE_TAG = 'codehs-goal-zone';
  var embedOrigin = new URLSearchParams(window.location.search).get('embedOrigin');
  if (!embedOrigin || window.parent === window) {
    return;
  }

  // GEARS restores the last program from localStorage when it boots. Every
  // embedded program shares this origin's storage, so clear it before the
  // GEARS scripts run; the parent sends the right program in `init`.
  try {
    localStorage.removeItem('blocklyXML');
    localStorage.removeItem('gearsPythonCode');
    localStorage.removeItem('gearsPythonModified');
    localStorage.setItem('whatsNew', '99999999');
  } catch (e) {
    // Storage can be blocked in third-party iframes; GEARS still runs.
  }

  var challenge = null;
  var lastProjectText = null;
  var runState = null;
  var initialized = false;
  // Robot position right after the last reset. Pressing Play does not move
  // the robot back to the start, so a run only counts if it starts here.
  var startPosition = null;
  var START_TOLERANCE_CM = 5;

  function post(type, payload) {
    var message = Object.assign({ source: SOURCE, type: type }, payload || {});
    window.parent.postMessage(message, embedOrigin);
  }

  function robotPosition() {
    if (typeof robot === 'undefined' || !robot.body) {
      return null;
    }
    return {
      x: Math.round(robot.body.position.x * 10) / 10,
      y: Math.round(robot.body.position.z * 10) / 10,
    };
  }

  function currentProject() {
    var files;
    if (filesManager.modified) {
      filesManager.updateCurrentFile();
      files = Object.assign({}, filesManager.files);
    } else {
      files = { 'main.py': blockly.generator.genCode() };
    }
    return {
      blocksXml: blockly.getXmlText(),
      files: files,
      pythonModified: !!filesManager.modified,
    };
  }

  function currentWorld() {
    var options = JSON.parse(JSON.stringify(babylon.world.options || {}));
    if (Array.isArray(options.objects)) {
      options.objects = options.objects.filter(function(obj) {
        return obj.codehsTag !== GOAL_ZONE_TAG;
      });
    }
    return { worldName: babylon.world.name, options: options };
  }

  function goalZoneObject(zone) {
    return {
      type: 'box',
      codehsTag: GOAL_ZONE_TAG,
      position: [zone.x, zone.y, 0.25],
      rotationMode: 'degrees',
      rotation: [0, 0, 0],
      size: [zone.width, zone.length, 0.5],
      color: '#22c55e88',
      physicsOptions: 'false',
      isPickable: false,
      receiveShadows: false,
      castShadows: false,
    };
  }

  function loadWorld(world, zone) {
    var copy = JSON.parse(JSON.stringify(world));
    copy.options = copy.options || {};
    var objects = Array.isArray(copy.options.objects) ? copy.options.objects : [];
    objects = objects.filter(function(obj) { return obj.codehsTag !== GOAL_ZONE_TAG; });
    if (zone) {
      objects.push(goalZoneObject(zone));
    }
    copy.options.objects = objects;
    simPanel.loadWorld(JSON.stringify(copy));
  }

  function loadProject(project) {
    if (!project) {
      return;
    }
    if (project.blocksXml) {
      blockly.loadXmlText(project.blocksXml);
    }
    var files = project.files || {};
    if (project.pythonModified && Object.keys(files).length) {
      filesManager.deleteAll();
      Object.keys(files).forEach(function(name) {
        filesManager.add(name, files[name]);
      });
      filesManager.select('main.py');
      filesManager.modified = true;
      blocklyPanel.setDisable(true);
    } else {
      filesManager.modified = false;
      blocklyPanel.setDisable(false);
      pythonPanel.loadPythonFromBlockly();
    }
    blockly.unsaved = false;
    filesManager.unsaved = false;
  }

  function lockWorldControls() {
    var style = document.createElement('style');
    style.textContent = '.worldsMenu, #simPanel .world { display: none !important; }';
    document.head.appendChild(style);
  }

  function inZone(pos, zone) {
    return (
      Math.abs(pos.x - zone.x) <= zone.width / 2 &&
      Math.abs(pos.y - zone.y) <= zone.length / 2
    );
  }

  function finishRun(passed, reason) {
    if (!runState || runState.finished) {
      return;
    }
    var elapsedMs = Date.now() - runState.startedAt;
    // Keep the finished run until the program stops so it isn't seen as a
    // new run on the next tick.
    runState.finished = true;
    post('result', {
      passed: passed,
      reason: reason,
      position: robotPosition(),
      elapsedMs: elapsedMs,
    });
    if (passed) {
      toastMsg('Goal reached!');
    } else if (reason === 'not_from_start') {
      toastMsg('Press Reset, then Play, to check the challenge.');
    }
  }

  // Poll instead of wrapping GEARS functions: its buttons bind handlers by
  // reference at startup, so wrapping simPanel.runSim would miss clicks.
  function tick() {
    if (!initialized) {
      return;
    }
    var running = typeof skulpt !== 'undefined' && skulpt.running;
    if (running && !runState) {
      var pos0 = robotPosition();
      var fromStart = !!(startPosition && pos0 &&
        Math.abs(pos0.x - startPosition.x) <= START_TOLERANCE_CM &&
        Math.abs(pos0.y - startPosition.y) <= START_TOLERANCE_CM);
      startPosition = null;
      runState = { startedAt: Date.now(), finished: false };
      post('run');
      if (!fromStart) {
        finishRun(false, 'not_from_start');
      }
    }
    if (runState && runState.finished) {
      if (!running) {
        runState = null;
      }
      return;
    }
    if (runState) {
      var zone = challenge && challenge.goalZone;
      var pos = robotPosition();
      var limit = challenge && challenge.timeLimitSeconds;
      if (zone && pos && inZone(pos, zone)) {
        finishRun(true, 'reached_goal');
      } else if (limit && Date.now() - runState.startedAt > limit * 1000) {
        finishRun(false, 'time_limit');
      } else if (!running) {
        // Give the robot a moment to coast after the program ends.
        if (!runState.stoppedAt) {
          runState.stoppedAt = Date.now();
        } else if (Date.now() - runState.stoppedAt > 1500) {
          finishRun(false, 'program_ended');
        }
      } else {
        runState.stoppedAt = null;
      }
    }
  }

  function reportProjectChanges() {
    if (!initialized) {
      return;
    }
    var project = currentProject();
    var text = JSON.stringify(project);
    if (text !== lastProjectText) {
      lastProjectText = text;
      post('project', { project: project });
    }
    // CodeHS saves the work, so keep GEARS from warning on page unload.
    blockly.unsaved = false;
    filesManager.unsaved = false;
  }

  function fitCameraToField() {
    var opts = babylon.world.processedOptions || {};
    var size = Math.max(opts.groundLength || 0, opts.groundWidth || 0);
    if (size > 0 && babylon.cameraArc) {
      babylon.cameraArc.beta = Math.PI / 4;
      babylon.cameraArc.radius = Math.max(200, size * 1.1);
    }
  }

  // GEARS calls simPanel.resetSim by name (Reset button, world loads), so
  // wrapping it sees every reset.
  function watchResets() {
    var originalReset = simPanel.resetSim;
    simPanel.resetSim = function() {
      return originalReset.apply(simPanel, arguments).then(function(value) {
        // Let the physics settle before reading the start position.
        setTimeout(function() { startPosition = robotPosition(); }, 300);
        // GEARS's default camera hugs the robot, which can leave the goal
        // off screen. Pull back far enough to see the whole field. The
        // timeout runs after GEARS's own camera reset on the same promise.
        setTimeout(fitCameraToField, 0);
        return value;
      });
    };
  }

  function handleInit(data) {
    challenge = data.challenge || null;
    if (data.lockWorld) {
      lockWorldControls();
    }
    if (data.world) {
      loadWorld(data.world, challenge && challenge.goalZone);
    }
    loadProject(data.project);
    lastProjectText = JSON.stringify(currentProject());
    initialized = true;
    post('initialized');
  }

  window.addEventListener('message', function(event) {
    if (event.origin !== embedOrigin || event.source !== window.parent) {
      return;
    }
    var data = event.data;
    if (!data || data.source !== SOURCE) {
      return;
    }
    if (data.type === 'init') {
      // The parent answers every repeated 'ready', so several inits can
      // arrive; only the first may load the program, or a late one would
      // wipe the student's edits. Later changes must set `update: true`.
      if (!initialized || data.update) {
        handleInit(data);
      }
    } else if (data.type === 'getState') {
      post('state', {
        requestId: data.requestId,
        world: currentWorld(),
        project: currentProject(),
        position: robotPosition(),
      });
    }
  });

  function waitForScene() {
    if (typeof babylon !== 'undefined' && babylon.scene && babylon.scene.isReady() &&
        typeof main !== 'undefined') {
      // Repeat until the parent answers, in case its listener attached late.
      watchResets();
      // CodeHS saves the program, so GEARS's "leave site?" prompt would only
      // block students from navigating away.
      window.removeEventListener('beforeunload', main.checkUnsaved);
      startPosition = robotPosition();
      post('ready');
      var readyTimer = setInterval(function() {
        if (initialized) {
          clearInterval(readyTimer);
        } else {
          post('ready');
        }
      }, 1000);
      setInterval(tick, 100);
      setInterval(reportProjectChanges, 1000);
    } else {
      setTimeout(waitForScene, 100);
    }
  }

  window.addEventListener('load', waitForScene);
})();
