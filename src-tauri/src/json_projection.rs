use std::fmt;
use std::io::Read;

use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::Value;

/// Retain selected fields while validating the entire JSON document.
#[derive(Clone, Copy)]
pub(crate) enum JsonProjection {
    Object(&'static [(&'static str, Self)]),
    Array(&'static Self, fn(&Value) -> bool),
    First(&'static Self, fn(&Value) -> bool),
    Scalar,
    Discard,
}

#[cfg(test)]
thread_local! {
    static PROJECTED_BYTES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static FIRST_MATCH_CANDIDATES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn take_usage_projected_bytes() -> usize {
    PROJECTED_BYTES.with(|count| count.replace(0))
}

#[cfg(test)]
pub(crate) fn take_first_match_candidates() -> usize {
    FIRST_MATCH_CANDIDATES.with(|count| count.replace(0))
}

impl JsonProjection {
    pub(crate) fn parse(self, json: &str) -> serde_json::Result<Value> {
        #[cfg(test)]
        PROJECTED_BYTES.with(|count| count.set(count.get() + json.len()));
        let mut deserializer = serde_json::Deserializer::from_str(json);
        let value = self.deserialize(&mut deserializer)?;
        deserializer.end()?;
        Ok(value)
    }

    pub(crate) fn read(self, reader: impl Read) -> serde_json::Result<Value> {
        let mut deserializer = serde_json::Deserializer::from_reader(reader);
        let value = self.deserialize(&mut deserializer)?;
        deserializer.end()?;
        Ok(value)
    }

    fn scalar(self, value: impl Into<Value>) -> Value {
        match self {
            Self::Scalar => value.into(),
            _ => Value::Null,
        }
    }
}

impl<'de> DeserializeSeed<'de> for JsonProjection {
    type Value = Value;

    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for JsonProjection {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let Self::Object(fields) = self else {
            while map.next_key_seed(Self::Discard)?.is_some() {
                map.next_value_seed(Self::Discard)?;
            }
            return Ok(Value::Null);
        };
        let mut selected = serde_json::Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if let Some((_, projection)) = fields.iter().find(|(field, _)| *field == key.as_str()) {
                selected.insert(key, map.next_value_seed(*projection)?);
            } else {
                map.next_value_seed(Self::Discard)?;
            }
        }
        Ok(Value::Object(selected))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        match self {
            Self::Array(projection, include) => {
                let mut selected = Vec::new();
                while let Some(item) = seq.next_element_seed(*projection)? {
                    if include(&item) {
                        selected.push(item);
                    }
                }
                Ok(Value::Array(selected))
            }
            Self::First(projection, include) => {
                while let Some(item) = seq.next_element_seed(*projection)? {
                    #[cfg(test)]
                    FIRST_MATCH_CANDIDATES.with(|count| count.set(count.get() + 1));
                    if include(&item) {
                        while seq.next_element_seed(Self::Discard)?.is_some() {}
                        return Ok(item);
                    }
                }
                Ok(Value::Null)
            }
            _ => {
                while seq.next_element_seed(Self::Discard)?.is_some() {}
                Ok(Value::Null)
            }
        }
    }

    fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Value, E> {
        Ok(self.scalar(value))
    }

    fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Value, E> {
        Ok(self.scalar(value))
    }

    fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Value, E> {
        Ok(self.scalar(value))
    }

    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Value, E> {
        Ok(self.scalar(value))
    }

    fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Value, E> {
        Ok(self.scalar(value))
    }

    fn visit_unit<E: serde::de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
}
