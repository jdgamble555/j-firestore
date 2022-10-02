/* eslint-disable no-useless-catch */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { deleteDoc, doc, DocumentReference, getDoc, increment, serverTimestamp, setDoc, writeBatch, onSnapshot } from "firebase/firestore";
import { combineLatest, Observable, of } from "rxjs";
import { map, switchMap } from "rxjs/operators";
export async function docExists(ref) {
    return (await getDoc(ref)).exists();
}
export async function setWithCounter(ref, data, setOptions, opts) {
    setOptions = setOptions ? setOptions : {};
    opts = opts ? opts : {};
    opts.dates = opts.dates === undefined
        ? true
        : opts.dates;
    const paths = opts.paths;
    // counter collection
    const counterCol = '_counters';
    const col = ref.path.split('/').slice(0, -1).join('/');
    const countRef = doc(ref.firestore, counterCol, col);
    const refSnap = await getDoc(ref);
    // don't increase count if edit
    try {
        if (refSnap.exists()) {
            if (opts.dates) {
                data = { ...data, updatedAt: serverTimestamp() };
            }
            await setDoc(ref, data, setOptions);
            // increase count
        }
        else {
            // set doc
            const batch = writeBatch(ref.firestore);
            if (opts.dates) {
                data = { ...data, createdAt: serverTimestamp() };
            }
            batch.set(ref, data, setOptions);
            // if other counts
            if (paths) {
                const keys = Object.keys(paths);
                keys.map((k) => {
                    batch.update(doc(ref.firestore, `${k}/${paths[k]}`), {
                        [col + 'Count']: increment(1),
                        ['_' + col + 'Doc']: ref
                    });
                });
            }
            // _counter doc
            batch.set(countRef, {
                count: increment(1),
                _tmpDoc: ref
            }, { merge: true });
            // create counts
            return await batch.commit();
        }
    }
    catch (e) {
        throw e;
    }
}
export async function deleteWithCounter(ref, opts) {
    opts = opts ? opts : {};
    const paths = opts.paths;
    // counter collection
    const counterCol = '_counters';
    const col = ref.path.split('/').slice(0, -1).join('/');
    const countRef = doc(ref.firestore, counterCol, col);
    const batch = writeBatch(ref.firestore);
    try {
        // if other counts
        if (paths) {
            const keys = Object.keys(paths);
            keys.map((k) => {
                batch.update(doc(ref.firestore, `${k}/${paths[k]}`), {
                    [col + 'Count']: increment(-1),
                    ['_' + col + 'Doc']: ref
                });
            });
        }
        // delete doc
        batch.delete(ref);
        batch.set(countRef, {
            count: increment(-1),
            _tmpDoc: ref
        }, { merge: true });
        // edit counts
        return await batch.commit();
    }
    catch (e) {
        throw e;
    }
}
export function expandRef(obs, fields = []) {
    return obs.pipe(switchMap((doc) => doc ? combineLatest((fields.length === 0 ? Object.keys(doc).filter((k) => {
        const p = doc[k] instanceof DocumentReference;
        if (p)
            fields.push(k);
        return p;
    }) : fields).map((f) => docData(doc[f], { idField: 'id' }))).pipe(map((r) => fields.reduce((prev, curr) => ({ ...prev, [curr]: r.shift() }), doc))) : of(doc)));
}
export function expandRefs(obs, fields = []) {
    return obs.pipe(switchMap((col) => col.length !== 0 ? combineLatest(col.map((doc) => (fields.length === 0 ? Object.keys(doc).filter((k) => {
        const p = doc[k] instanceof DocumentReference;
        if (p)
            fields.push(k);
        return p;
    }) : fields).map((f) => docData(doc[f], { idField: 'id' }))).reduce((acc, val) => [].concat(acc, val)))
        .pipe(map((h) => col.map((doc2) => fields.reduce((prev, curr) => ({ ...prev, [curr]: h.shift() }), doc2)))) : of(col)));
}
/**
 *
 * @param param: {
 *  ref - document ref
 *  data - document data
 *  del - boolean - delete past index
 *  useSoundex - index with soundex
 *  docObj - the document object in case of ssr,
 *  soundexFunc - change out soundex function for other languages,
 *  copyFields - field values to copy from original document
 * }
 * @returns
 */
export async function searchIndex({ ref, data, fields, del = false, useSoundex = true, docObj = document, soundexFunc = soundex, copyFields = [], allCol = '_all', searchCol = '_search', termField = '_term', numWords = 6 }) {
    const colId = ref.path.split('/').slice(0, -1).join('/');
    // get collection
    const searchRef = doc(ref.firestore, `${searchCol}/${colId}/${allCol}/${ref.id}`);
    try {
        if (del) {
            await deleteDoc(searchRef);
        }
        else {
            let _data = {};
            const m = {};
            // go through each field to index
            for (const field of fields) {
                // new indexes
                let fieldValue = data[field];
                // if array, turn into string
                if (Array.isArray(fieldValue)) {
                    fieldValue = fieldValue.join(' ');
                }
                let index = createIndex(docObj, fieldValue, numWords);
                // if filter function, run function on each word
                if (useSoundex) {
                    const temp = [];
                    for (const i of index) {
                        temp.push(i.split(' ').map((v) => soundexFunc(v)).join(' '));
                    }
                    index = temp;
                    for (const phrase of index) {
                        if (phrase) {
                            let v = '';
                            const t = phrase.split(' ');
                            while (t.length > 0) {
                                const r = t.shift();
                                v += v ? ' ' + r : r;
                                // increment for relevance
                                m[v] = m[v] ? m[v] + 1 : 1;
                            }
                        }
                    }
                }
                else {
                    for (const phrase of index) {
                        if (phrase) {
                            let v = '';
                            for (let i = 0; i < phrase.length; i++) {
                                v = phrase.slice(0, i + 1).trim();
                                // increment for relevance
                                m[v] = m[v] ? m[v] + 1 : 1;
                            }
                        }
                    }
                }
            }
            if (copyFields.length) {
                const d = {};
                for (const k in copyFields) {
                    d[k] = copyFields[k];
                }
                _data = { ...d, ..._data };
            }
            _data[termField] = m;
            return await setDoc(searchRef, _data);
        }
    }
    catch (e) {
        throw e;
    }
}
export function createIndex(doc, html, n) {
    // create document after text stripped from html
    // get rid of pre code blocks
    const beforeReplace = (text) => {
        return text.replace(/&nbsp;/g, ' ').replace(/<pre[^>]*>([\s\S]*?)<\/pre>/g, '');
    };
    const createDocs = (text) => {
        const finalArray = [];
        const wordArray = text
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .replace(/ +/g, ' ')
            .trim()
            .split(' ');
        do {
            finalArray.push(wordArray.slice(0, n).join(' '));
            wordArray.shift();
        } while (wordArray.length !== 0);
        return finalArray;
    };
    // strip text from html
    const extractContent = (html) => {
        if (typeof window === undefined) {
            // can't run on server currently
            return html;
        }
        const tmp = doc.createElement('div');
        tmp.innerHTML = html;
        return tmp.textContent || tmp.innerText || '';
    };
    // get rid of code first
    return createDocs(extractContent(beforeReplace(html)));
}
export function soundex(s) {
    const a = s.toLowerCase().split("");
    const f = a.shift();
    let r = "";
    const codes = {
        a: "",
        e: "",
        i: "",
        o: "",
        u: "",
        b: 1,
        f: 1,
        p: 1,
        v: 1,
        c: 2,
        g: 2,
        j: 2,
        k: 2,
        q: 2,
        s: 2,
        x: 2,
        z: 2,
        d: 3,
        t: 3,
        l: 4,
        m: 5,
        n: 5,
        r: 6,
    };
    r = f + a
        .map((v) => codes[v])
        .filter((v, i, b) => i === 0 ? v !== codes[f] : v !== b[i - 1])
        .join("");
    return (r + "000").slice(0, 4).toUpperCase();
}
// taken from rxFire and simplified
// https://github.com/FirebaseExtended/rxfire/blob/main/firestore/document/index.ts
export function snapToData(snapshot, options = {}) {
    const data = snapshot.data();
    // match the behavior of the JS SDK when the snapshot doesn't exist
    // it's possible with data converters too that the user didn't return an object
    if (!snapshot.exists() || typeof data !== 'object' || data === null) {
        return data;
    }
    if (options.idField) {
        data[options.idField] = snapshot.id;
    }
    return data;
}
export function docData(ref, options = {}) {
    return new Observable((subscriber) => onSnapshot(ref, subscriber))
        .pipe(map((snap) => snapToData(snap, options)));
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscUNBQXFDO0FBQ3JDLHVEQUF1RDtBQUN2RCxPQUFPLEVBQ0gsU0FBUyxFQUNULEdBQUcsRUFFSCxpQkFBaUIsRUFDakIsTUFBTSxFQUNOLFNBQVMsRUFDVCxlQUFlLEVBQ2YsTUFBTSxFQUVOLFVBQVUsRUFFVixVQUFVLEVBRWIsTUFBTSxvQkFBb0IsQ0FBQztBQUM1QixPQUFPLEVBQ0gsYUFBYSxFQUNiLFVBQVUsRUFDVixFQUFFLEVBQ0wsTUFBTSxNQUFNLENBQUM7QUFDZCxPQUFPLEVBQ0gsR0FBRyxFQUNILFNBQVMsRUFDWixNQUFNLGdCQUFnQixDQUFDO0FBRXhCLE1BQU0sQ0FBQyxLQUFLLFVBQVUsU0FBUyxDQUFJLEdBQXlCO0lBQ3hELE9BQU8sQ0FBQyxNQUFNLE1BQU0sQ0FBSSxHQUFHLENBQUMsQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDO0FBQzNDLENBQUM7QUFFRCxNQUFNLENBQUMsS0FBSyxVQUFVLGNBQWMsQ0FDaEMsR0FBeUIsRUFDekIsSUFBOEIsRUFDOUIsVUFBdUIsRUFDdkIsSUFHQztJQUdELFVBQVUsR0FBRyxVQUFVLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0lBQzFDLElBQUksR0FBRyxJQUFJLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0lBQ3hCLElBQUksQ0FBQyxLQUFLLEdBQUcsSUFBSSxDQUFDLEtBQUssS0FBSyxTQUFTO1FBQ2pDLENBQUMsQ0FBQyxJQUFJO1FBQ04sQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUM7SUFFakIsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQztJQUV6QixxQkFBcUI7SUFDckIsTUFBTSxVQUFVLEdBQUcsV0FBVyxDQUFDO0lBQy9CLE1BQU0sR0FB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RUFBRSxDQUFDLENBQUM7SUFDcEMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBWSxDQUFDO0lBQzlCLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztJQUNYLE1BQU0sS0FBSyxHQUFHO1FBQ1YsQ0FBQyxFQUFFLEVBQUU7UUFDTCxDQUFDLEVBQUUsRUFBRTtRQUNMLENBQUMsRUFBRSxFQUFFO1FBQ0wsQ0FBQyxFQUFFLEVBQUU7UUFDTCxDQUFDLEVBQUUsRUFBRTtRQUNMLENBQUMsRUFBRSxDQUFDO1FBQ0osQ0FBQyxFQUFFLENBQUM7UUFDSixDQUFDLEVBQUUsQ0FBQztRQUNKLENBQUMsRUFBRSxDQUFDO1FBQ0osQ0FBQyxFQUFFLENBQUM7UUFDSixDQUFDLEVBQUUsQ0FBQztRQUNKLENBQUMsRUFBRSxDQUFDO1FBQ0osQ0FBQyxFQUFFLENBQUM7UUFDSixDQUFDLEVBQUUsQ0FBQztRQUNKLENBQUMsRUFBRSxDQUFDO1FBQ0osQ0FBQyxFQUFFLENBQUM7UUFDSixDQUFDLEVBQUUsQ0FBQztRQUNKLENBQUMsRUFBRSxDQUFDO1FBQ0osQ0FBQyxFQUFFLENBQUM7UUFDSixDQUFDLEVBQUUsQ0FBQztRQUNKLENBQUMsRUFBRSxDQUFDO1FBQ0osQ0FBQyxFQUFFLENBQUM7UUFDSixDQUFDLEVBQUUsQ0FBQztLQUNBLENBQUM7SUFDVCxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUM7U0FDSixHQUFHLENBQUMsQ0FBQyxDQUFTLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztTQUM1QixNQUFNLENBQUMsQ0FBQyxDQUFNLEVBQUUsQ0FBUyxFQUFFLENBQVEsRUFBRSxFQUFFLENBQ3BDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO1NBQzdDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUNkLE9BQU8sQ0FBQyxDQUFDLEdBQUcsS0FBSyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxXQUFXLEVBQUUsQ0FBQztBQUNqRCxDQUFDO0FBRUQsbUNBQW1DO0FBQ25DLG1GQUFtRjtBQUVuRixNQUFNLFVBQVUsVUFBVSxDQUN0QixRQUE2QixFQUM3QixVQUVJLEVBQUU7SUFFTixNQUFNLElBQUksR0FBRyxRQUFRLENBQUMsSUFBSSxFQUFTLENBQUM7SUFDcEMsbUVBQW1FO0lBQ25FLCtFQUErRTtJQUMvRSxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU0sRUFBRSxJQUFJLE9BQU8sSUFBSSxLQUFLLFFBQVEsSUFBSSxJQUFJLEtBQUssSUFBSSxFQUFFO1FBQ2pFLE9BQU8sSUFBSSxDQUFDO0tBQ2Y7SUFDRCxJQUFJLE9BQU8sQ0FBQyxPQUFPLEVBQUU7UUFDakIsSUFBSSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsR0FBRyxRQUFRLENBQUMsRUFBRSxDQUFDO0tBQ3ZDO0lBQ0QsT0FBTyxJQUFTLENBQUM7QUFDckIsQ0FBQztBQUVELE1BQU0sVUFBVSxPQUFPLENBQ25CLEdBQXlCLEVBQ3pCLFVBRUksRUFBRTtJQUVOLE9BQU8sSUFBSSxVQUFVLENBQXNCLENBQUMsVUFBZSxFQUFFLEVBQUUsQ0FBQyxVQUFVLENBQUMsR0FBVSxFQUFFLFVBQVUsQ0FBQyxDQUFDO1NBQzlGLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsT0FBTyxDQUFNLENBQUMsQ0FBQyxDQUFDO0FBQzdELENBQUMifQ==