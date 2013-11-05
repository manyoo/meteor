ObserveSequence = {
  // A mechanism similar to cursor.observe which receives a reactive
  // function returning a sequence type and firing appropriate callbacks
  // when the value changes.
  //
  // @param sequenceFunc {Function} a reactive function returning a
  //     sequence type. The currently supported sequence types are:
  //     'null', arrays and cursors.
  //
  // @param callbacks {Object} similar to a specific subset of
  //     callbacks passed to `cursor.observe`
  //     (http://docs.meteor.com/#observe), with minor variations to
  //     support the fact that not all sequences contain objects with
  //     _id fields.  Specifically:
  //
  //     * addedAt(id, item, atIndex, beforeId)
  //     * changed(id, newItem, oldItem)
  //     * removed(id, oldItem)
  //     * movedTo(id, item, fromIndex, toIndex, beforeId)
  //
  // @returns {Object(stop: Function)} call 'stop' on the return value
  //     to stop observing this sequence function.
  //
  // XXX currently only supports the callbacks used by our
  // implementation of {{#each}}, but this can be expanded.
  //
  // XXX #each doesn't use the indices (though we'll eventually need
  // a way to get them when we support `@index`), but calling
  // `cursor.observe` causes the index to be calculated on every
  // callback using a linear scan (unless you turn it off by passing
  // `_no_indices`).  Any way to avoid calculating indices on a pure
  // cursor observe like we used to?
  observe: function (sequenceFunc, callbacks) {
    var lastSeq = null;
    var activeObserveHandle = null;

    // `lastSeqArray` contains the previous value of the sequence
    // we're observing. It is an array of objects with `_id` and
    // `item` fields.  `item` is the element in the array, or the
    // document in the cursor.  `_id` is set from `item._id` if
    // available (and must be unique), or generated uniquely
    // otherwise.
    var lastSeqArray = []; // elements are objects of form {_id, item}
    var computation = Deps.autorun(function () {
      var seq = sequenceFunc();
      var seqArray; // same structure as `lastSeqArray` above.

      // If this is not the first time this `autorun` block executes
      // and the last sequence was a cursor, fetch its contents so
      // that we can diff against the new sequence.
      Deps.nonreactive(function () {
        if (isMinimongoCursor(lastSeq)) {
	  lastSeq.rewind(); // so that we can fetch
          lastSeqArray = _.map(lastSeq.fetch(), function (doc) {
            return {_id: doc._id, item: doc};
          });
          lastSeq.rewind(); // so that the user can still fetch
        }
      });

      if (!seq) {
        seqArray = [];
        diffArray(lastSeqArray, seqArray, callbacks);
      } else if (seq instanceof Array) {
	// XXX if id is not set, we just set it randomly for now.  We
	// can do better so that diffing the arrays ["A", "B"] and
	// ["A"] doesn't cause "A" to be removed.
        seqArray = _.map(seq, function (doc, i) {
          return { _id: doc._id || Random.id(), item: doc };
        });
        diffArray(lastSeqArray, seqArray, callbacks);
      } else if (isMinimongoCursor(seq)) {
        var cursor = seq;
        if (lastSeq !== cursor) { // fresh cursor.
	  // Fetch the contents of the new cursor so that we can diff
	  // from the old sequence.
          Deps.nonreactive(function () { 
	    cursor.rewind(); // so that we can fetch
            seqArray = _.map(cursor.fetch(), function (doc) {
              return {_id: doc._id, item: doc};
            });
            cursor.rewind(); // so that the user can still fetch
          });

	  // diff the old sequnce with initial data in the new cursor. this will fire
	  // `addedAt` callbacks on the initial data.
          diffArray(lastSeqArray, seqArray, callbacks);

          if (activeObserveHandle) {
            activeObserveHandle.stop();
          }

	  // make sure to not fire duplicate `addedAt` callbacks for
	  // initial data
          var initial = true;

          activeObserveHandle = cursor.observe({
            addedAt: function (document, atIndex, before) {
              if (!initial)
                callbacks.addedAt(document._id, document, atIndex, before);
            },
            changed: function (newDocument, oldDocument) {
              callbacks.changed(newDocument._id, newDocument, oldDocument);
            },
            removed: function (oldDocument) {
              callbacks.removed(oldDocument._id, oldDocument);
            },
            movedTo: function (document, fromIndex, toIndex, before) {
              callbacks.movedTo(document._id, document, fromIndex, toIndex, before);
            }
          });
          initial = false;
        }
      } else {
        throw new Error("Not a recognized sequence type. Currently only arrays, cursors or "
                        + "falsey values accepted.");
      }

      lastSeq = seq;
      lastSeqArray = seqArray;
    });

    return {
      stop: function () {
        computation.stop();
      }
    };
  }
};

var isMinimongoCursor = function (seq) {
  var minimongo = Package.minimongo;
  return !!minimongo && (seq instanceof minimongo.LocalCollection.Cursor);
};

// Calculates the differences between `lastSeqArray` and
// `seqArray` and calls appropriate functions from `callbacks`.
// Reuses Minimongo's diff algorithm implementation.
var diffArray = function (lastSeqArray, seqArray, callbacks) {
  var diffFn = Package.minimongo.LocalCollection._diffQueryOrderedChanges;
  var oldIdObjects = [];
  var newIdObjects = [];
  var posOld = {};
  var posNew = {};

  _.each(seqArray, function (doc, i) {
    newIdObjects.push(_.pick(doc, '_id'));
    posNew[doc._id] = i;
  });
  _.each(lastSeqArray, function (doc, i) {
    oldIdObjects.push(_.pick(doc, '_id'));
    posOld[doc._id] = i;
  });

  // Arrays can contain arbitrary objects. We don't diff the
  // objects. Instead we always fire 'changed' callback on every
  // object. The consumer of `observe-sequence` should deal with
  // it appropriately.
  diffFn(oldIdObjects, newIdObjects, {
    addedBefore: function (id, doc, before) {
      callbacks.addedAt(id, seqArray[posNew[id]].item, posNew[id], before);
    },
    movedBefore: function (id, before) {
      callbacks.movedTo(id, seqArray[posNew[id]].item, posOld[id], posNew[id], before);
    },
    removed: function (id) {
      callbacks.removed(id, lastSeqArray[posOld[id]].item);
    }
  });

  _.each(posNew, function (pos, id) {
    if (_.has(posOld, id))
      callbacks.changed(id, lastSeqArray[posOld[id]].item, seqArray[pos].item);
  });
};
