const test = require("ava");
const Qottle = require('../src/qottle');
const { pTimeout } = Qottle;
const LEEWAY = 100

test("init", (t) => {
  const q = new Qottle()
  t.deepEqual(q.list(), []);
  t.is(q.queueSize(), 0);
  t.is(q.stickySize(), 0);
  t.is(q.activeSize(), 0);
});

test("adding immediate", (t) => {
  const q = new Qottle();
  q.on("add", ({ entry }) => {
    t.is(entry.status, "queued");
  })

  // should start right away
  return q.add(({ entry }) => {
    t.is(entry.status, 'active')
  })
})

test("adding stopped", (t) => {
  const q = new Qottle({
    immediate: false
  });

  q.on("add", ({ entry }) => {
    t.is(entry.status, "queued");
  });

  const p = q.add(({ entry }) => {
    return t.is(entry.status, "active");
  })

  // wait a bit then start the queue
  pTimeout(100).then(() => q.startQueue()) 

  return p.then(({ entry }) => {
    t.is(entry.status, "finish");
    return {entry}
  })
});

test("error handling - dont catch", t => { 
  const q = new Qottle({
    concurrent: 3,
    catchError: false
  });
  q.on("error", ({ entry, error }) => { 
    t.is(error.message, entry.key);
    t.is(entry.key, "fail")
  })
  const order = []
  q.on("finish", ({ entry }) => { 
    order.push(entry.key)
  })
  const mss = [2000, 500]
  const mr = mss.map(f => q.add(() => pTimeout(f), { key: f }));
  
  return Promise.all(mr.concat(
    q.add(
      ({ entry }) => {
        throw new Error(entry.key);
      },
      { key: "fail" }
    ).catch(({ error, entry }) => { 
      t.is(error.message, entry.key)
      t.is(entry.key, entry.key);
    }))).then((results) => { 
      return pTimeout(1000).then(()=>t.deepEqual(order, mss.sort((a,b)=> a-b)))
    })

})

test("error handling - catch", (t) => {
  const q = new Qottle({
    concurrent: 3,
    catchError: true,
  });
  q.on("error", ({ entry, error }) => {
    t.is(error.message, entry.key);
    t.is(entry.key, "fail");
  });
  q.on("finish", ({ error }) => {
    t.is(error, undefined)
  });

  return Promise.all([
    q.add(() => pTimeout(500), { key: "b.second" }),
    q.add(() => pTimeout(50), { key: "b.first" }),
    q
      .add(
        ({ entry }) => {
          throw new Error(entry.key);
        },
        { key: "fail" }
      )
      .then(({ error, entry }) => {
        t.is(error.message, entry.key);
        t.is(entry.key, entry.key);
      }),
  ]);
});



test("check key skipping single threaded", t => {
  const q = new Qottle({
    concurrent: 1,
    skipDuplicates: true,
  });
  // this signal should match the original order
  const finishedOrder = [];
  q.on("finish", (pack) => {
    finishedOrder.push(pack.entry.key);
  });

  // should do it in order and skip dups
  const mss = [4000, 1000, 4000, 2000, 4000];
  const order = mss.filter((f, i, a) => a.indexOf(f) === i);
  const skip = mss.filter((f, i, a) => a.indexOf(f) !== i);
  const p = mss.map((m) => q.add(() => pTimeout(m), { key: m }));

  return Promise.all(p).then((results) => {
    const ordered = results
      .filter((f) => !f.entry.skipped)
      .map((f) => f.result);
    const skipped = results
      .filter((f) => f.entry.skipped)
      .map((f) => f.entry.key);

    t.deepEqual(finishedOrder, ordered);
    t.deepEqual(ordered, order);
    t.deepEqual(skipped, skip);

    return results;
  });
  
});

test("check key skipping multi threaded", (t) => {
  const q = new Qottle({
    concurrent: 10,
    skipDuplicates: true,
  });
  const mss = [4000, 1000, 4000, 2000, 4000];
  const order = mss
    .filter((f, i, a) => a.indexOf(f) === i)
    .sort((a, b) => a - b);
  const skip = mss
    .filter((f, i, a) => a.indexOf(f) !== i)
    .sort((a, b) => a - b);
  const p = mss.map((m) => q.add(() => pTimeout(m), { key: m }));
  const finishedOrder = [];
  // this time the order should be the quickest to run finished 1st
  q.on("finish", (pack) => {
    finishedOrder.push(pack.entry.key);
  });

  return Promise.all(p).then((results) => {
    const ordered = results
      .filter((f) => !f.entry.skipped)
      .map((f) => f.result)
      .sort((a, b) => a - b);
    const skipped = results
      .filter((f) => f.entry.skipped)
      .map((f) => f.entry.key)
      .sort((a, b) => a - b);
    t.deepEqual(finishedOrder, ordered);
    t.deepEqual(ordered, order);
    t.deepEqual(skipped, skip);

    return results;
  });
});

test("check no key multi threaded", (t) => {
  const q = new Qottle({
    concurrent: 10,
    skipDuplicates: true,
  });
  const mss = [4000, 1000, 4000, 2000, 4000];
  const order = mss
    .filter((f, i, a) => a.indexOf(f) === i)
    .sort((a, b) => a - b);

  const p = mss.map((m) => q.add(() => pTimeout(m), { key: m }));
  const finishedOrder = [];
  // this time the order should be the quickest to run finished 1st
  q.on("finish", (pack) => {
    finishedOrder.push(pack.entry.key);
  });

  return Promise.all(p).then((results) => {
    const ordered = results
      .filter((f) => !f.entry.skipped)
      .map((f) => f.result)
      .sort((a, b) => a - b);

    t.deepEqual(finishedOrder, ordered);
    t.deepEqual(ordered, order);

    return results;
  });
});

test("priorities no skipping multi threaded", (t) => {
  const q = new Qottle({
    concurrent: 10,
    skipDuplicates: false,
    immediate: false,
  });
  // the start order should be obey priority since we're not auto starting
  const startOrder = [];
  q.on("start", (pack) => {
    startOrder.push(pack.entry.key);
  });
  t.is(q.isStarted(), false);
  q.on("startqueue", () => {
    console.log("queue started");
  });
  const mss = [4000, 1000, 4000, 2000, 4000];
  const order = mss.sort((a, b) => a - b);
  const p = mss.map((m) =>
    q.add(() => pTimeout(m), { key: m, priority: m })
  );
  

  q.startQueue();
  t.is(q.isStarted(), true);
  return Promise.all(p).then((results) => {
    const ordered = results.map((f) => f.result);
    t.deepEqual(startOrder, order);
    t.deepEqual(ordered, mss);
    return results;
  });
});


test("removing", (t) => { 
  const q = new Qottle({
    concurrent: 1,
    skipDuplicates: false,
    immediate: false
  });
  const mss = [4000, 1000, 4000, 2000, 4000];
  const p = mss.map((m) =>
    q.add(() => pTimeout(m), { key: m})
  );
  q.list().filter(f => f.key === 2000).forEach(f => q.remove(f))
  const list = q.list().map(k => k.key)
  t.deepEqual(
    list,
    mss.filter((f) => f !== 2000)
  );
  q.startQueue()
  return Promise.all(p)
  
})


test("check no key skipping multi threaded rate limited - 1 every 2 seconds", (t) => {
  const q = new Qottle({
    concurrent: 1,
    skipDuplicates: false,
    rateLimited: true,
    rateLimitMax: 1,
    rateLimitPeriod: 2000
  });

  const mss = [2, 1, 3, 5, 4];
  const p = mss.map((m) => q.add(() => pTimeout(m), { key: m }));

  return Promise.all(p).then((results) => {
    t.deepEqual(results.map(f => f.entry.key), mss);
    results.forEach((f,i) => { 
      // the wait times for each should be close to the ratelimitperiod except for the first
      const w = Math.abs(f.entry.rateLimitPeriod - f.entry.waitTime)
      // within LEEWAYms of expectation
      t.is((w < LEEWAY) || !i,  true)
    })
    return results;
  });
});


test("check no key skipping multiple threaded rate limited - 1 every 3 seconds", (t) => {
  const q = new Qottle({
    concurrent: 5,
    skipDuplicates: false,
    rateLimited: true,
    rateLimitMax: 1,
    rateLimitPeriod: 3000
  });

  const mss = [2, 1, 3, 5, 4];
  const p = mss.map((m) => q.add(() => pTimeout(m), { key: m }));

  return Promise.all(p).then((results) => {
    t.deepEqual(
      results.map((f) => f.entry.key),
      mss
    );
    results.forEach((f, i) => {
      // harder to test this one as the concurrent will all keep trying
      const w = Math.abs(f.entry.rateLimitPeriod - f.entry.waitTime);
      // within LEEWAYms of expectation
      t.is(w < LEEWAY || !i, true);
    });
    return results;
  });
});

test("check no key skipping multiple threaded rate limited - 2 every 1.5 seconds", (t) => {
  const q = new Qottle({
    concurrent: 3,
    skipDuplicates: false,
    rateLimited: true,
    rateLimitMax: 2,
    rateLimitPeriod: 1500,
  });
  // everybody should have  to wait
  let waits = 0;

  const mss = [2, 1, 3, 5, 4];
  const p = mss.map((m) => q.add(() => pTimeout(m), { key: m }));
  // because the only 2 of them should be held up because of rate limits
  const expectedWait = 2 * 1500
  return Promise.all(p).then((results) => {
    t.deepEqual(
      results.map((f) => f.entry.key),
      mss
    );
    
    const w = results.reduce((p,c) => {
      return p + c.entry.waitTime
    }, 0);
    t.is(Math.abs(w - expectedWait) < LEEWAY, true);
    return results;
  });
});

test("check delay with ratelimit between each call plus delay period", (t) => {
  const q = new Qottle({
    concurrent: 3,
    skipDuplicates: false,
    rateLimited: true,
    rateLimitMax: 2,
    rateLimitPeriod: 1500,
    rateLimitDelay: 4000
  });

  const mss = [20, 1000, 300, 500, 40];
  const p = mss.map((m) => q.add(() => pTimeout(m), { key: m }));
  // 4 of these should be delated
  const expectedWait = (mss.length -1) * 4000
  return Promise.all(p).then((results) => {
    t.deepEqual(
      results.map((f) => f.entry.key),
      mss
    );
    const w = results.reduce((p, c) => {
      return p + c.entry.waitTime;
    }, 0);
    const x = Math.abs(w - expectedWait) < LEEWAY;
    if(!x)console.log(`${w - expectedWait}`);
    t.is(x, true); // , `${w - expectedWait}`
    return results;
  });
});

test("check sticky", (t) => {
  const q = new Qottle({
    concurrent: 1,
    skipDuplicates: true,
    sticky: true
  });
  // this signal should match the original order
  const finishedOrder = [];
  q.on("finish", (pack) => {
    finishedOrder.push(pack.entry.key);
  });

  // should do it in order and skip dups
  const mss = [4000, 1000, 4000, 2000, 4000];
  const order = mss.filter((f, i, a) => a.indexOf(f) === i);
  const skip = mss.filter((f, i, a) => a.indexOf(f) !== i);
  const p = mss.map((m) => q.add(() => pTimeout(m), { key: m }));
  q.on('empty', () => { 
    q.list().forEach((f) => {
      t.is(f.error, undefined);
    });
  })
  return Promise.all(p).then((results) => {
    const ordered = results
      .filter((f) => !f.entry.skipped)
      .map((f) => f.result);
    const skipped = results
      .filter((f) => f.entry.skipped)
      .map((f) => f.entry.key);

    t.deepEqual(finishedOrder, ordered);
    t.deepEqual(ordered, order);
    t.deepEqual(skipped, skip);
    t.is(q.list().length, ordered.length)
    t.is(q.list().every(f => f.status === 'finish'), true);
    return results;
  })

});

test("check non sticky", (t) => {
  const q = new Qottle({
    concurrent: 5,
    skipDuplicates: true,
    sticky: false,
  });
  // this signal should match the original order
  const finishedOrder = [];
  q.on("empty", (pack) => {
    t.is(q.list().length, 0);
  });

  // should do it in order and skip dups
  const mss = [4000, 1000, 4000, 2000, 4000];
  const order = mss.filter((f, i, a) => a.indexOf(f) === i);
  const skip = mss.filter((f, i, a) => a.indexOf(f) !== i);
  const p = mss.map((m) => q.add(() => pTimeout(m), { key: m }));
  q.on("empty", () => {
    q.list().forEach((f) => {
      t.is(f.error, undefined);
    });
  });
  return Promise.all(p)
    .then((results) => {
      t.is(q.list().length, 0);
      return results;
    });
});
