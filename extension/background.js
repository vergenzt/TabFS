// This file is the heart of TabFS. Each route (synthetic file) is
// defined by an entry in the Routes object.

const unix = {
  EPERM: 1,
  ENOENT: 2,
  ESRCH: 3,
  EINTR: 4,
  EIO: 5,
  ENXIO: 6,
  ENOTSUP: 45,
  ETIMEDOUT: 110, // FIXME: not on macOS (?)

  // Unix file types
  S_IFMT: 0170000, // type of file mask
  S_IFIFO: 010000, // named pipe (fifo)
  S_IFCHR: 020000, // character special
  S_IFDIR: 040000, // directory
  S_IFBLK: 060000, // block special
  S_IFREG: 0100000, // regular
  S_IFLNK: 0120000, // symbolic link
  S_IFSOCK: 0140000, // socket
}
class UnixError extends Error {
  constructor(error) { super(); this.name = "UnixError"; this.error = error; }
}

const sanitize = (function() {
  // from https://github.com/parshap/node-sanitize-filename/blob/209c39b914c8eb48ee27bcbde64b2c7822fdf3de/index.js

  // I've added ' ' to the list of illegal characters. it's a
  // decision whether we want to allow spaces in filenames... I think
  // they're annoying, so I'm sanitizing them out for now.
  var illegalRe = /[\/\?<>\\:\*\|" ]/g;
  var controlRe = /[\x00-\x1f\x80-\x9f]/g;
  var reservedRe = /^\.+$/;
  var windowsReservedRe = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
  var windowsTrailingRe = /[\. ]+$/;

  function sanitize(input, replacement) {
    if (typeof input !== 'string') {
      throw new Error('Input must be string');
    }
    var sanitized = input
      .replace(illegalRe, replacement)
      .replace(controlRe, replacement)
      .replace(reservedRe, replacement)
      .replace(windowsReservedRe, replacement)
      .replace(windowsTrailingRe, replacement);
    return sanitized.slice(0, 200);
  }
  return input => sanitize(input, '_');
})();

const stringToUtf8Array = (function() {
  const encoder = new TextEncoder("utf-8");
  return str => encoder.encode(str);
})();
const utf8ArrayToString = (function() {
  const decoder = new TextDecoder("utf-8");
  return utf8 => decoder.decode(utf8);
})();

// global so it can be hot-reloaded
window.Routes = {};

// Helper function: you provide getData and setData functions that define
// the contents of an entire file => it returns a proper route handler
// object with a full set of file operations that you can put in
// `Routes` (so clients can read and write sections of the file, stat
// it to get its size and see it show up in ls, etc),
const makeRouteWithContents = (function() {
  const Cache = {
    // used when you open a file to cache the content we got from the
    // browser until you close that file. (so we can respond to
    // individual chunk read() and write() requests without doing a
    // whole new conversation with the browser and regenerating the
    // content -- important for taking a screenshot, for instance)
    store: {}, nextHandle: 0,
    storeObject(path, object) {
      const handle = ++this.nextHandle;
      this.store[handle] = {path, object};
      return handle;
    },
    getObjectForHandle(handle) { return this.store[handle].object; },
    setObjectForHandle(handle, object) { this.store[handle].object = object; },
    removeObjectForHandle(handle) { delete this.store[handle]; },
    setObjectForPath(path, object) {
      for (let storedObject of Object.values(this.store)) {
        if (storedObject.path === path) {
          storedObject.object = object;
        }
      }
    }
  };

  function toUtf8Array(stringOrArray) {
    if (typeof stringOrArray == 'string') { return stringToUtf8Array(stringOrArray); }
    else { return stringOrArray; }
  }

  const makeRouteWithContents = (getData, setData) => ({
    // getData: (req: Request U Vars) -> Promise<contentsOfFile: String|Uint8Array>
    // setData [optional]: (req: Request U Vars, newContentsOfFile: String) -> Promise<>

    // You can override file operations (like `truncate` or `getattr`)
    // in the returned set if you want different behavior from what's
    // defined here.

    async getattr(req) {
      const data = await getData(req);
      if (typeof data === 'undefined') { throw new UnixError(unix.ENOENT); }
      return {
        st_mode: unix.S_IFREG | 0444 | (setData ? 0222 : 0),
        st_nlink: 1,
        // you'll want to override this if getData() is slow, because
        // getattr() gets called a lot more cavalierly than open().
        st_size: toUtf8Array(data).length
      };
    },

    // We call getData() once when the file is opened, then cache that
    // data for all subsequent reads from that application.
    async open(req) {
      const data = await getData(req);
      if (typeof data === 'undefined') { throw new UnixError(unix.ENOENT); }
      return { fh: Cache.storeObject(req.path, toUtf8Array(data)) };
    },
    async read({fh, size, offset}) {
      return { buf: String.fromCharCode(...Cache.getObjectForHandle(fh).slice(offset, offset + size)) };
    },
    async write(req) {
      const {fh, offset, buf} = req;
      let arr = Cache.getObjectForHandle(fh);
      const bufarr = stringToUtf8Array(buf);
      if (offset + bufarr.length > arr.length) {
        const newArr = new Uint8Array(offset + bufarr.length);
        newArr.set(arr.slice(0, Math.min(offset, arr.length)));
        arr = newArr;
        Cache.setObjectForHandle(fh, arr);
      }
      arr.set(bufarr, offset);
      // I guess caller should override write() if they want to actually
      // patch and not just re-set the whole string (for example,
      // if they want to hot-reload just one function the user modified)
      await setData(req, utf8ArrayToString(arr)); return { size: bufarr.length };
    },
    async release({fh}) { Cache.removeObjectForHandle(fh); return {}; },

    async truncate(req) {
      let arr = toUtf8Array(await getData(req));
      if (req.size !== arr.length) {
        const newArr = new Uint8Array(req.size);
        newArr.set(arr.slice(0, Math.min(req.size, arr.length)));
        arr = newArr;
      }
      Cache.setObjectForPath(req.path, arr);
      await setData(req, utf8ArrayToString(arr)); return {};
    }
  });
  makeRouteWithContents.Cache = Cache;
  return makeRouteWithContents;
})();

Routes["/tabs.json"]       = makeRouteWithContents(async () => JSON.stringify(await browser.tabs.query()));
Routes["/tab-groups.json"] = makeRouteWithContents(async () => JSON.stringify(await browser.tabGroups.query()));
Routes["/windows.json"]    = makeRouteWithContents(async () => JSON.stringify(await browser.windows.getAll({ populate: true })));

// most specific (lowest matchVarCount) routes should match first
const sortedRoutes = Object.values(Routes).sort((a, b) =>
  a.__matchVarCount - b.__matchVarCount
);
function tryMatchRoute(path) {
  if (path.match(/\/\._[^\/]+$/)) {
    // Apple Double ._whatever file for xattrs
    throw new UnixError(unix.ENOTSUP); 
  }

  for (let route of sortedRoutes) {
    const vars = route.__match(path);
    if (vars) { return [route, vars]; }
  }
  throw new UnixError(unix.ENOENT);
}

let port;
async function onMessage(req) {
  if (req.buf) req.buf = atob(req.buf);
  console.log('req', req);

  let response = { op: req.op, error: unix.EIO };
  let didTimeout = false, timeout = setTimeout(() => {
    // timeout is very useful because some operations just hang
    // (like trying to take a screenshot, until the tab is focused)
    didTimeout = true; console.error('timeout');
    port.postMessage({ id: req.id, op: req.op, error: unix.ETIMEDOUT });
  }, 1000);

  /* console.time(req.op + ':' + req.path);*/
  try {
    const [route, vars] = tryMatchRoute(req.path);
    response = await route[req.op]({...req, ...vars});
    response.op = req.op;
    if (response.buf) { response.buf = btoa(response.buf); }

  } catch (e) {
    console.error(e);
    response = {
      op: req.op,
      error: e instanceof UnixError ? e.error : unix.EIO
    };
  }
  /* console.timeEnd(req.op + ':' + req.path);*/

  if (!didTimeout) {
    clearTimeout(timeout);

    console.log('resp', response);
    response.id = req.id;
    port.postMessage(response);
  }
};

function tryConnect() {
  // Safari is very weird -- it has this native app that we have to talk to,
  // so we poke that app to wake it up, get it to start the TabFS process
  // and boot a WebSocket, then connect to it.
  // Is there a better way to do this?
  if (chrome.runtime.getURL('/').startsWith('safari-web-extension://')) { // Safari-only
    chrome.runtime.sendNativeMessage('com.rsnous.tabfs', {op: 'safari_did_connect'}, resp => {
      console.log(resp);

      let socket;
      function connectSocket(checkAfterTime) {
        socket = new WebSocket('ws://localhost:9991');
        socket.addEventListener('message', event => {
          onMessage(JSON.parse(event.data));
        });

        port = { postMessage(message) {
          socket.send(JSON.stringify(message));
        } };

        setTimeout(() => {
          if (socket.readyState === 1) {
          } else {
            console.log('ws connection failed, retrying in', checkAfterTime);
            connectSocket(checkAfterTime * 2);
          }
        }, checkAfterTime);
      }
      connectSocket(200);
    });
    return;
  }
  
  port = chrome.runtime.connectNative('com.rsnous.tabfs');
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(p => {
    console.log('disconnect', p);
  });
}


if (typeof process === 'object') {
  // we're running in node (as part of a test)
  // return everything they might want to test
  module.exports = {Routes, tryMatchRoute}; 

} else {
  tryConnect();
}

