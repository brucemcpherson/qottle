const { truncateSync } = require("fs");
const { runInThisContext } = require("vm");

class Qottle {
  // because you'll probably need it
  static pTimeout = (ms = 1000) =>
    new Promise((resolve) =>
      setTimeout(() => {
        resolve(ms);
      }, ms)
    );

  constructor(options) {
    this.options = {
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
      rateLimitMinWait: 100,
      // any optional changes to all that
      ...options,
    };

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
      add: []
    };
    // for simplicity ids a are just consecutive
    this.counter = 0;

    // considered a new ratelimit attempt
    this._NEW_ATTEMPT = 20

    // get started or not
    this._paused = true;
    if (this.options.immediate) {
      this.startQueue();
    } else {
      this.stopQueue();
    }
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
    return this._allQueues().map(f=>f.entry)
  }

  _allQueues() { 
    return this.active.concat(this.queue, this.sticky)
  }
  // is this key already known
  getBykey(key = null) {
    return key !== null && this._allQueues().find((f) => f.entry.key === key);
  }

  /**
   * on - add a listener
   * returns an ID than can be used to remove it
   */
  on(eventName, listener) {
    if (!this.events[eventName]) {
      throw new Error(`unknown event name ${eventName}`);
    }
    this._checkFunction(listener);
    const id = new Date().getTime() + Math.random();
    const ob = {
      listener,
      id,
      eventName,
    };
    this.events[eventName].push(ob);
    return ob;
  }

  /*
   * off - remove a listener
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
   * add an item to be executed
   * @param {function}  action something to execute - it will return a promise
   * @param {object} options various run options
   * @return {object} a queue item
   */
  add(action, options = {}) {
    // check it's a function
    this._checkFunction(action);
    // do some admin
    const queuedAt = new Date().getTime();
    const id = ++this.counter;
    // most of this stuff won't be of interest to caller
    // but provide anyway i case it is
    const entry = {
      ...this.options,
      ...options,
      status: "queued",
      queuedAt,
      startedAt: null,
      finishedAt: null,
      elapsed: null,
      runTime: null,
      skipped: false,
      id,
      action,
      waitTime: 0,
      attempts: 0,
      waitStartedAt: null,
      waitFinishedAt: null,
      waitUntil: null
    };

    // wrap in a promise so handle finishing
    let resolve = null;
    let reject = null;
    const pack = new Promise((r, e) => {
      resolve = r;
      reject = e;
    });
    const item = {
      entry,
      resolve,
      reject
    };
    // if duplicates are being skipped and there's a key and we already know it

    if (entry.skipDuplicates && this.getBykey(entry.key)) {
      if (entry.log) {
        console.log(
          `....pqlog:${new Date().getTime()}:skipped ${entry.id} as duplicated}`
        );
      }
      entry.skipped = true;
      this._serviceEvent({
        eventName: "skip",
        entry,
      });
      return Promise.resolve({
        entry,
      });
    }

    // do whatever comes next
    this._addToQueue(item);
    this._serviceQueue();

    // return the promise to the execution of the action
    return pack;
  }

  // stop the queue when all active ones have finished
  stopQueue() {
    this._paused = true;
    this._serviceEvent({
      eventName: "stopqueue",
    });
    return this
  }

  // restart the queue
  startQueue() {
    this._paused = false;
    this._serviceEvent({
      eventName: "startqueue",
    });
    this._serviceQueue();
    return this
  }

  // is the queue started
  isStarted() {
    return !this._paused;
  }

  // check something is a function and fail if required
  _checkFunction(func, fail = true) {
    const t = typeof func;
    if (t === "function") return true;
    if (fail) throw new Error(`Expected function but got ${t}`);
    return false;
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
    const now = this._now()
    // how many have we done within scope of rate
    this.rateLimitHistory = this.rateLimitHistory.filter(
      (f) => !this._isInscope(f,now) && !this._isTooSoon(f,now)
    );
    return this.rateLimitHistory
  }

  drain() {
    this.clear();
    this.clearSticky();
    this.clearRateLimitHistory();
    console.log(
      `....queues drained. There were ${this.activeSize} still running - drain again when completed`
    );
    return this.list();
  }

  _registerResolution({ entry, result, error }) {

    const eventName = error ? "error" : "finish"
    entry.finishedAt = new Date().getTime();
    entry.runTime = entry.finishedAt - entry.startedAt;
    entry.status = eventName;
    entry.elapsed = entry.finishedAt - entry.queuedAt;
    entry.error = error;

    // throwing and error  varies by options
    // but an error event is always signalled
    const ob = {
      entry,
      result,
      error,
      eventName
    };
    // remove this item from the queue
    this._finish(entry);
    this._checkEmpty();

    // do any events
    this._serviceEvent(ob);

    if (entry.log) {
      this._logger({
        entry,
        message: `${entry.finishedAt}:${eventName} ${entry.id}${this._keyText(entry)}`
      })
    }

    return ob;
  }

  _registerWaitTime ({ entry }) { 
    if (entry.waitStartedAt) { 
      entry.waitFinishedAt = entry.startedAt
      entry.waitTime = entry.waitFinishedAt - entry.waitStartedAt;
    }
    return entry
  }

  _logger({ entry, message }) { 
    if (entry.log) {
      console.log(`....pqlog:${message}`)
    }
    return entry
  }

  // start something running
  _startItem({ item }) {

    // resolve and reject apply to the q.add() so completion returns a resolved promise
    const { entry, resolve, reject } = item;

    entry.startedAt = new Date().getTime();
    entry.status = "active";

    // if we were waiting then mark the end of the wait
    this._registerWaitTime({entry})

    // do any logging
    this._logger({
      entry,
      message: `${entry.startedAt}:starting ${entry.id}${this._keyText(entry)}`
    })

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
        resolve(entry.action({ entry }))
      } catch (error) { 
        reject (error)
      }
    })

    // first we need to make it a  promise
    // the action will have been checked for being a function already - so we can just execute it
    return action
    .then(result => { 
      resolve(this._registerResolution({result, entry}))
    }).catch(error => { 
      const resolution = this._registerResolution({ entry, error });
      return entry.catchError ? resolve(resolution) : reject(resolution)
    })
    .finally(() => {
      this._serviceQueue();
    });
  }

  // move from active queue to finished queue
  _finish(entry) {
    const index = this.active.findIndex((f) => f.entry.id === entry.id);
    if (index === -1) {
      throw new Error(
        `couldnt find entry ${entry.id} ${entry.key} in active queue`
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
    if (entry.log) {
      console.log(
        `....pqlog:${new Date().getTime()}:added ${entry.id} to queue${
          entry.key ? "(" + entry.key + ")" : ""
        }`
      );
    }
    q.splice(index, 0, addition);
    this._serviceEvent({
      eventName: 'add',
      entry
    })
    return addition;
  }

  /**
   * see if we're allowed to run another one right now
   */
  _isInfinite() { 
    return this.options.concurrent === Infinity
  }
  _isRoomForAnother() { 
    return (this._isInfinite() || this.activeSize() < this.options.concurrent)
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
    const { rateLimitDelay, rateLimitMax, rateLimited, rateLimitPeriod} = this.options
    if (!rateLimited || (!rateLimitMax && !rateLimitDelay)) return 0;

    // housekeeping
    //this._tidyRateLimitHistory()

    // see if there's anything in the way of going again
    const scoped = this.callsInPeriod()
    const toosoon = this.callsInDelay()
    if (!scoped.length && !toosoon.length) return 0;

    // as long as there's no delay issue we still might be able to go
    if (!toosoon.length && scoped.length < rateLimitMax) return 0;

    // wiat for whichever is the longest
    const ts = toosoon.length && toosoon[toosoon.length-1]
    const sc = scoped.length && scoped[scoped.length-1]
    const nextTime = Math.max(
      ((ts && ts.startedAt) || 0) + rateLimitDelay,
      ((sc && sc.startedAt) || 0) + rateLimitPeriod
    ); 
    return nextTime
  }
  
  _isInscope = (historyItem, now) => { 
    // how long ago this started
    const t = now - historyItem.startedAt;
    // whether this should be considered a blocker
    const blocker =
      this.options.rateLimitPeriod && t < this.options.rateLimitPeriod;
    
    return blocker
    
  }
  _isTooSoon = (historyItem, now) => { 
    return historyItem.startedAt + this.options.rateLimitDelay >= now
  }

  // this returns all the calls that have been made inside the current rate limit period
  callsInDelay() { 
    const now = this._now();
    return this.rateLimitHistory.filter((f) =>
      this._isTooSoon(f, now)
    );

  }
  _now() {
    return new Date().getTime()
  }

  callsInPeriod() { 
    // how many have we done within scope of rate
    const now = this._now();
    return this.rateLimitHistory.filter(f => {
        return this._isInscope(f, now)
      }
    )
  }
  /**
   * action a queue item
   */
  _serviceQueue() {

    // if the queue isnt started, or theres' nothing to do or no room to do it then we're done
    if (!this.isStarted() || !this.queueSize() || !this._isRoomForAnother()) return Promise.resolve(null);
    
    // see if rate limiting allow something to run
    const waitUntil = this._nextOpportunity()

    // the first item in the queue
    const [item] = this.queue
    
    if (!waitUntil) {
      // remove from queued items and push to the active queu
      this.active.push(this.queue.shift())
      // start the thing
      return this._startItem({ item });
    } else {
      // wait till the next opportunity before trying again
      const {entry} = item
      const now = this._now()
      // we'll wait until this time before trying again
      const until = Math.max(
        this.options.rateLimitMinWait + now,
        waitUntil
      );
      // if its the first time we've seen this record it 
      if (!entry.waitStartedAt) { 
        entry.waitStartedAt = now
      }
      // other priotity items may have slipped in that needs a reevaluation of the waitime required
      const waitTime = until - now

      // if the waituntil time has changed significantly, then it's a new attempt
      if (!entry.waitUntil || Math.abs(entry.waitUntil - until) > this._NEW_ATTEMPT) { 
        entry.attempts++;
        this._serviceEvent({
          eventName: "ratewait",
          entry,
          waitTime,
        });
      }
      entry.waitUntil = until
      return this.constructor.pTimeout(waitTime).then(() => this._serviceQueue());
    }
  }
  /*
   * emit events
   */
  _serviceEvent(values) {
    const { eventName } = values
    this._checkEventName(eventName);
    this.events[eventName].forEach((f) => {
      f.listener({
        listener: f.listener,
        ...values
      });
    });
  }

  _checkEmpty() {
    const empty = this.activeSize()+ this.queueSize()=== 0;
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
    item.resolve(null)

    // finally if there's nothing left to do, emit queue as empty
    this._checkEmpty();
    return entry;
  }


}

module.exports = Qottle;
