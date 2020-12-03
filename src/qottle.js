// make sure something is a function
const _checkFunction = (func, fail = true) => {
  const t = typeof func;
  if (t === "function") return true;
  if (fail) throw new Error(`Expected function but got ${t}`);
  return false;
}

// get an id based on the time
const _flid  = () => new Date().getTime() + Math.random();

// just handy for pulling out the resolve/reject of a new promise
const _pack  = () => {   
  const promise = new Promise((r, e) => {
    resolve = r;
    reject = e;
  });
  return {
    promise, 
    resolve,
    reject
  }
}

class QottleListener { 
  constructor({ eventName, listener }) { 
    _checkFunction(listener);
    this.value = {
      eventName,
      listener,
      id: _flid()
    }
  }
}

class QottleEntry { 
  constructor({ qottleOptions = {}, options = {}, entry = {}}) {
    
    // check options are good - they are the same as the queue options and can enrich them
    const entryOptions = new QottleOptions({ ...qottleOptions, ...options }).value;

    // skeleton entry
    const now = new Date().getTime();
    this.defaultEntry = {
      status: "queued",
      queuedAt: now,
      startedAt: null,
      finishedAt: null,
      get elapsed () { 
        return this.queuedAt - this.startedAt;
      },
      get runTime() { 
        return this.finishedAt - this.startedAt;
      },
      skipped: false,
      id: now + Math.random(),
      action: ({ entry }) => Promise.resolve({entry}),
      waitTime: 0,
      attempts: 0,
      waitStartedAt: null,
      waitFinishedAt: null,
      waitUntil: null,
    };

    // check that all options are viable
    const errs = Object.keys(entry).filter(
      (f) => !this.defaultEntry.hasOwnProperty(f)
    );
    if (errs.length) {
      throw `invalid entry options ${errs.join(",")}`;
    }
    this.value = {
      // the queue options
      ...qottleOptions,
      // the options specific to the is entry
      ...entryOptions,
      // the entry parameters
      ...this.defaultEntry,
      ...entry
    };
  }
}

class QottleOptions { 

  constructor(options = {}) {
    this.defaultOptions  = {
      // queue level options
      // how many can run at once
      concurrent: Infinity,
      // whether to keep a note of all keys ever seen or just those currently active or running
      sticky: false,
      // whether ti start the queue immediately or wait till its manually started
      immediate: true,
      // the others can be set for each queue entry
      // 0 happens first
      priority: 100,
      // console progress messages
      log: false,
      // whether to catch an error and resolve or throw the error and reject
      catchError: false,
      // whether to care about keys when provided
      skipDuplicates: false,
      // enable rate limited
      // if you want to have multiple services with different rate limits use multiple queue instances
      // if enabled, no more than rateLimitCalls will made in any rateLimitPeriod
      // and no single call will be be made within rateLimitDelay of the previous one
      rateLimited: false,
      // if rate limitied, then how long is the rate limit over in ms
      rateLimitPeriod: 60000,
      // how long between calls
      rateLimitDelay: 0,
      // how many calls can be made in the period
      rateLimitMax: 1,
      // minimum delay time if a wait is required
      rateLimitMinWait: 10,
      // give the queue a name for logging
      name: 'qottle',
      // default key for entries
      key: null,
      // whether to error on dups
      errorOnDuplicate: false
    }
    // check that all options are viable
    const errs = Object.keys(options).filter((f) => !this.defaultOptions.hasOwnProperty(f))
    if (errs.length) {
      throw `invalid options ${errs.join(',')}`
    }
    this.value = {
      ...this.defaultOptions,
      ...options
    }
  }
}

class Qottle {
  constructor(options) {
    // default options
    this.options = new QottleOptions(options).value;

    // the things to be done
    this.queue = [];

    // things that have been done for sticky instances
    this.sticky = [];

    // the things that are active
    this.active = [];

    // this is used for preserving a history for rate limitiing
    this.rateLimitHistory = [];

    // eventName arguments to .on and .off
    this.events = {
      empty: [],
      error: [],
      finish: [],
      skip: [],
      start: [],
      startqueue: [],
      stopqueue: [],
      ratewait: [],
      add: [],
    };

    // for simplicity ids are just consecutive, starting at 1
    this.counter = 0;

    // considered a new ratelimit attempt to avoid too many ratewait events
    this._NEW_ATTEMPT = 0;

    // get started or not
    this._paused = true;
    if (this.options.immediate) {
      this.startQueue();
    } else {
      this.stopQueue();
    }
  }

  timer(ms = 0) {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(ms);
      }, ms);
    });
  }

  stickySize() {
    return this.sticky.length;
  }

  // how many are running
  activeSize() {
    return this.active.length;
  }

  // how many are queued
  queueSize() {
    return this.queue.length;
  }

  // return a list of all entries ever
  list() {
    return this._allQueues().map((f) => f.entry);
  }

  _allQueues() {
    return this.active.concat(this.queue, this.sticky);
  }
  // is this key already known
  getBykey(key = null) {
    return key !== null && this._allQueues().find((f) => f.entry.key === key);
  }

  /**
   * @param {string} eventName - triggered on this event
   * @param {function} listener - add a listener
   * @return {QottleListener} the listener - can be used to remove it
   */
  on(eventName, listener) {
    if (!this.events[eventName]) {
      throw new Error(`unknown event name ${eventName}`);
    }
    const ob = new QottleListener({ listener, eventName }).value;
    this.events[eventName].push(ob);
    return ob;
  }

  /**
   * @param {QottleListener} listener - remove a listener
   * @return {QottleListener} the removed listener
   */
  off(listener) {
    // find the listener
    const l = this.events[listener.eventName].find((f) => f.id === listener.id);
    if (!l) {
      throw new Error(
        `Listener ${listener.eventName}:${listener.id} not found`
      );
    }
    this.events[listener.eventName] = this.events[listener.eventName].filter(
      (f) => f.id !== listener.id
    );
    return l;
  }

  /*
   * purge all events for a given type of if 'all' then all of them
   */
  clearListeners(eventName) {
    if (eventName === "all") {
      Object.keys(this.events).forEach((k) => (this.events[k] = []));
    } else {
      this._checkEventName(eventName);
      this.events[eventName] = [];
    }
    return this;
  }

  _checkEventName(eventName) {
    if (this.events[eventName]) return true;
    throw new Error(`no such event ${eventName}`);
  }

  /**
   * handling duplicates if they need to be skipped
   * @param {object} item the item to be habdled contains the entry, resolve, and reject
   */
  _handleDuplicate({ item }) { 
    const { entry, resolve, reject } = item;
    this._logger({
      entry,
      message: `skipped ${entry.id} as duplicated}`,
    });
    entry.skipped = true;
    entry.status = "skipped";

    // resolve before flagging the event
    // resolution depends on whether we're treating a dup as an error
    const error = new Error(`entry was skipped because of duplicate key ${entry.key}`);
    item[entry.errorOnDuplicate ? 'reject' : 'resolve']({
      entry,
      error
    });
    // now service a skip event or an error event
    this._serviceEvent({
      eventName: entry.errorOnDuplicate ? "error" : "skip",
      entry,
      error,
    });
    return item;
  }
  /**
   * add an item to be executed
   * @param {function}  action something to execute - it will return a promise
   * @param {object} options various run options
   * @return {object} a queue item
   */
  add(action, options = {}) {
    // check it's a function
    _checkFunction(action);

    // do some admin
    const id = ++this.counter;

    // most of this stuff won't be of interest to caller
    // but provide anyway in case it is
    const eo = new QottleEntry({
      qottleOptions: this.options,
      options,
      entry: {
        action,
        id,
      },
    });
    const entry = eo.value;

    // this is a promise that willbe resolved on the item being actioned/or not
    const pack = _pack()

    const item = {
      entry,
      resolve: pack.resolve,
      reject: pack.reject
    };

    // if duplicates are being skipped and there's a key and we already know it
    if (entry.skipDuplicates && this.getBykey(entry.key)) {
      this._handleDuplicate({ item })
    } else {
      // this is clear to add to the queue
      this._addToQueue(item);
      this._serviceQueue();
    }

    // return the promise to the execution of the action
    return pack.promise;
  }

  // stop the queue when all active ones have finished
  stopQueue() {
    this._paused = true;
    this._serviceEvent({
      eventName: "stopqueue",
    });
    return this;
  }

  // restart the queue
  startQueue() {
    this._paused = false;
    this._serviceEvent({
      eventName: "startqueue",
    });
    this._serviceQueue();
    return this;
  }

  // is the queue started
  isStarted() {
    return !this._paused;
  }

  // clean the key text for logging
  _keyText(entry) {
    return entry.key ? "(" + entry.key + ")" : "";
  }

  // clean out everything except that aleady running
  clear() {
    this.queue = [];
    return this;
  }

  clearSticky() {
    this.sticky = [];
    return this;
  }

  clearRateLimitHistory() {
    this.clearRateLimitHistory = [];
    return this;
  }

  // only need to keep those that might affect rate limit
  _tidyRateLimitHistory() {
    const now = this._now();
    // how many have we done within scope of rate
    this.rateLimitHistory = this.rateLimitHistory.filter(
      (f) => !this._isInscope(f, now) && !this._isTooSoon(f, now)
    );
    return this.rateLimitHistory;
  }

  drain() {
    this.clear();
    this.clearSticky();
    this.clearRateLimitHistory();
    this._logger({
      entry,
      message: `queues drained. There were ${this.activeSize} still running - drain again when completed`,
    });
    return this.list();
  }

  _registerResolution({ entry, result, error , eventName}) {
    eventName = eventName || (error ? "error" : "finish");
    entry.finishedAt = new Date().getTime();
    entry.status = eventName;
    entry.error = error;

    // throwing and error  varies by options
    // but an error event is always signalled
    const ob = {
      entry,
      result,
      error,
      eventName,
    };
    // remove this item from the queue
    this._finish(entry);

    this._checkEmpty();

    if (entry.log) {
      this._logger({
        entry,
        message: `${entry.finishedAt}:${eventName} ${entry.id}${this._keyText(
          entry
        )}`,
      });
    }

    // do any events
    this._serviceEvent(ob);
    return ob;
  }

  _registerWaitTime({ entry }) {
    if (entry.waitStartedAt) {
      entry.waitFinishedAt = entry.startedAt;
      entry.waitTime = entry.waitFinishedAt - entry.waitStartedAt;
    }
    return entry;
  }

  _logger({ entry, message }) {
    if (entry.log) {
      console.log(`....queue:${this.options.name}:${message}`);
    }
    return entry;
  }

  // start something running
  _startItem({ item }) {
    // resolve and reject apply to the q.add() so completion returns a resolved promise
    const { entry, resolve, reject } = item;

    entry.startedAt = new Date().getTime();
    entry.status = "active";

    // if we were waiting then mark the end of the wait
    this._registerWaitTime({ entry });

    // do any logging
    this._logger({
      entry,
      message: `${entry.startedAt}:starting ${entry.id}${this._keyText(entry)}`,
    });

    // emit that we're going live
    this._serviceEvent({
      eventName: "start",
      entry,
    });

    // push to history for rate limit purposes
    this.rateLimitHistory.push({
      startedAt: entry.startedAt,
      id: entry.id,
      key: entry.key,
    });

    // make the action into a promise
    const action = new Promise((resolve, reject) => {
      try {
        resolve(entry.action({ entry }));
      } catch (error) {
        reject(error);
      }
    });

    // first we need to make it a  promise
    // the action will have been checked for being a function already - so we can just execute it
    return action
      .then((result) => {
        // this is would be some kind of internal error
        try {
          resolve(this._registerResolution({ result, entry, eventName: 'finish' }));
        } catch (error) {
          reject(this._registerResolution({ error, entry, eventName: 'error' }));
        }
      })
      .catch((error) => {
        // this would be an error in execution
        const resolution = this._registerResolution({ entry, error, eventName: 'error' });
        entry.catchError ? resolve(resolution) : reject(resolution);
        
      })
      .finally(() => { 
        this._serviceQueue();
      })
  }

  // move from active queue to finished queue
  _finish(entry) {
    const index = this.active.findIndex((f) => f.entry.id === entry.id);
    if (index === -1) {
      throw new Error(
        `${entry.name}:couldnt find entry ${entry.id} ${entry.key} in active queue`
      );
    }
    const [item] = this.active.splice(index, 1);
    if (this.options.sticky) this.sticky.push(item);
    return entry;
  }

  // add an item to the queue - queue remains sorted according to priority then id
  _addToQueue(addition) {
    // find its position - things that need to happen first are at the beginning of the queue
    // lower priority values are more urgent than higher values
    let index = 0;
    const { entry } = addition;
    const q = this.queue;
    while (
      q[index] &&
      (q[index].entry.priority < entry.priority ||
        (q[index].entry.priority === entry.priority &&
          q[index].entry.id < entry.id))
    )
      index++;

    this._logger({
      entry,
      message: `added ${entry.id} to queue${
        entry.key ? "(" + entry.key + ")" : ""
      }`,
    });

    q.splice(index, 0, addition);
    this._serviceEvent({
      eventName: "add",
      entry,
    });
    return addition;
  }

  /**
   * see if we're allowed to run another one right now
   */
  _isInfinite() {
    return this.options.concurrent === Infinity;
  }
  _isRoomForAnother() {
    return this._isInfinite() || this.activeSize() < this.options.concurrent;
  }
  /**
   * rate limits
   * - concurrency should be set for the queue.concurrent - how many simultaneous equests can there be
   * - rate limits are  a little different because it counts concurrency not as how many are acive now
   * - but how many could have been active in in a given period
   *
   * - rateLimitPeriod - how many ms the measurement lasts for
   * - rateLimitMax - how mant calls can be made within that period
   * - so if an API allows 10 calls per minute
   *  { rateLimitPeriod: 60 * 60 * 1000 , rateLimitMax: 10 }
   * this
   */
  _nextOpportunity() {
    // no need to wait at all
    const {
      rateLimitDelay,
      rateLimitMax,
      rateLimited,
      rateLimitPeriod,
    } = this.options;
    if (!rateLimited || (!rateLimitMax && !rateLimitDelay)) return 0;

    // housekeeping
    //this._tidyRateLimitHistory()

    // see if there's anything in the way of going again
    const scoped = this.callsInPeriod();
    const toosoon = this.callsInDelay();
    if (!scoped.length && !toosoon.length) return 0;

    // as long as there's no delay issue we still might be able to go
    if (!toosoon.length && scoped.length < rateLimitMax) return 0;

    // wiat for whichever is the longest
    const ts = toosoon.length && toosoon[toosoon.length - 1];
    const sc = scoped.length && scoped[scoped.length - 1];
    const nextTime = Math.max(
      ((ts && ts.startedAt) || 0) + rateLimitDelay,
      ((sc && sc.startedAt) || 0) + rateLimitPeriod
    );
    return nextTime;
  }

  _isInscope = (historyItem, now) => {
    // how long ago this started
    const t = now - historyItem.startedAt;
    // whether this should be considered a blocker
    const blocker =
      this.options.rateLimitPeriod && t < this.options.rateLimitPeriod;

    return blocker;
  };
  _isTooSoon = (historyItem, now) => {
    return historyItem.startedAt + this.options.rateLimitDelay >= now;
  };

  // this returns all the calls that have been made inside the current rate limit period
  callsInDelay() {
    const now = this._now();
    return this.rateLimitHistory.filter((f) => this._isTooSoon(f, now));
  }
  _now() {
    return new Date().getTime();
  }

  callsInPeriod() {
    // how many have we done within scope of rate
    const now = this._now();
    return this.rateLimitHistory.filter((f) => {
      return this._isInscope(f, now);
    });
  }
  /**
   * action a queue item
   */
  _serviceQueue() {
    
    // if the queue isnt started, or theres' nothing to do or no room to do it then we're done
    if (!this.isStarted() || !this.queueSize() || !this._isRoomForAnother())
      return null;

    // see if rate limiting allow something to run
    const waitUntil = this._nextOpportunity();

    // the first item in the queue
    const [item] = this.queue;

    if (!waitUntil) {
      // remove from queued items and push to the active queu
      this.active.push(this.queue.shift());
      // start the thing
      return this._startItem({ item });
    } else {
      // wait till the next opportunity before trying again
      const { entry } = item;
      const now = this._now();
      // we'll wait until this time before trying again
      const until = Math.max(this.options.rateLimitMinWait + now, waitUntil);
      // if its the first time we've seen this record it
      if (!entry.waitStartedAt) {
        entry.waitStartedAt = now;
      }
      // other priotity items may have slipped in that needs a reevaluation of the waitime required
      const waitTime = until - now;

      // if the waituntil time has changed significantly, then it's a new attempt
      if (
        !entry.waitUntil ||
        Math.abs(entry.waitUntil - until) > this._NEW_ATTEMPT
      ) {
        entry.attempts++;
        this._serviceEvent({
          eventName: "ratewait",
          entry,
          waitTime,
        });

        entry.waitUntil = until;

        return this.timer(waitTime).then(() => {
          this._serviceQueue();
        });
      }
    }
  }
  /*
   * emit events
   */
  _serviceEvent(values) {
    const { eventName } = values;
    this._checkEventName(eventName);
    this.events[eventName].forEach((f) => {
      _checkFunction(f.listener)
      f.listener({
        listener: f.listener,
        ...values,
      });
    });
  }

  _checkEmpty() {
    const empty = this.activeSize() + this.queueSize() === 0;
    if (empty)
      this._serviceEvent({
        eventName: "empty",
      });
    return empty;
  }

  // this removes from queued items
  remove(entry) {
    const itemIndex = this.queue.findIndex((f) => f.entry.id === entry.id);
    if (itemIndex === -1) {
      throw new Error("....no such item", entry.id);
    }
    const [item] = this.queue.splice(itemIndex, 1);

    // need to resolve the removed item
    item.resolve(null);

    // finally if there's nothing left to do, emit queue as empty
    this._checkEmpty();
    return entry;
  }
}

module.exports = Qottle;
